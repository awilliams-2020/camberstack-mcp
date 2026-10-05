/**
 * The only way this service writes to a Google Ads account.
 *
 *   propose  → resolve every change against the live account, dry-run it with validateOnly, store
 *              it with a plain-English diff. Nothing is written.
 *   apply    → only a stored, un-applied proposal belonging to this user, less than 24h old. Each
 *              change records its inverse, so any applied proposal can be undone.
 *
 * Surface: negatives, pause/enable keyword, ad group or campaign, daily budget, campaign end date, and
 * building: a whole Search campaign (always created PAUSED, so building and spending are two separate
 * approvals), ad groups, keywords, responsive search ads, sitelinks, and which conversion category a
 * campaign bids on. No bid strategy changes on existing campaigns, no deleting anything a user built:
 * the only removals are undos of things this service created.
 */
import { z } from "zod";
import { micros, toMicros, type AdsClient } from "./google.js";

export const MAX_CHANGES = 50;
export const PROPOSAL_TTL = 24 * 3600;

const id = z.string().regex(/^\d+$/, "numeric id");
const campaignId = id.describe("Campaign id, digits only (campaign_id from account_overview or run_gaql)");
const adGroupId = id.describe("Ad group id, digits only (ad_group.id from run_gaql)");
const criterionId = id.describe("Keyword criterion id, digits only (ad_group_criterion.criterion_id from run_gaql)");
const matchType = z.enum(["EXACT", "PHRASE", "BROAD"]);
const bid = z.number().positive().max(1000);
const url = z.string().url().regex(/^https?:\/\//, "http(s) URL").max(2048);

const keywordSpec = z.object({
  text: z.string().min(1).max(80).describe("The keyword, e.g. \"cleaning invoice template\""),
  match_type: matchType.describe("PHRASE matches searches containing the words in order; the usual choice"),
  max_cpc: bid.optional().describe("Max cost per click for this keyword in the account's currency (manual CPC only); omit to use the ad group's"),
});
const adSpec = z.object({
  headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe("3 to 15 headlines, each at most 30 characters"),
  descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe("2 to 4 descriptions, each at most 90 characters"),
  final_url: url.describe("The landing page"),
  path1: z.string().min(1).max(15).optional().describe("Display path part 1, at most 15 characters"),
  path2: z.string().min(1).max(15).optional().describe("Display path part 2, at most 15 characters"),
}).describe("A responsive search ad");
const adGroupSpec = z.object({
  name: z.string().min(1).max(255),
  default_max_cpc: bid.optional().describe("Default max cost per click for the ad group (required when the campaign uses manual CPC)"),
  keywords: z.array(keywordSpec).min(1).max(50),
  ads: z.array(adSpec).min(1).max(3),
});
const sitelinkSpec = z.object({
  text: z.string().min(1).max(25).describe("Link text, at most 25 characters"),
  url,
  description1: z.string().min(1).max(35).optional().describe("At most 35 characters; give both descriptions or neither"),
  description2: z.string().min(1).max(35).optional(),
});
const negativeSpec = z.object({ text: z.string().min(1).max(80), match_type: matchType });
const goalCategory = z.string().regex(/^[A-Z_]+$/, "a conversion category such as SIGNUP")
  .describe("Conversion category, e.g. SIGNUP, PURCHASE, SUBMIT_LEAD_FORM, QUALIFIED_LEAD (see conversion_action.category in run_gaql)");

/**
 * What the AI may propose. Every field is described so a model can fill it without guessing where an
 * id comes from or what unit an amount is in (ChatGPT took ~2 minutes to work out a budget change
 * before these existed).
 */
const PUBLIC_CHANGES = [
  z.object({
    type: z.literal("add_negative_keywords"),
    campaign_id: campaignId,
    keywords: z.array(z.object({
      text: z.string().min(1).max(80).describe('The search words to block, e.g. "free"'),
      match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).describe("PHRASE blocks any search containing the words in order; the usual choice"),
    })).min(1).max(MAX_CHANGES),
  }).describe("Block searches containing these words in one campaign"),
  z.object({ type: z.literal("pause_keyword"), ad_group_id: adGroupId, criterion_id: criterionId }).describe("Pause one keyword"),
  z.object({ type: z.literal("enable_keyword"), ad_group_id: adGroupId, criterion_id: criterionId }).describe("Re-enable one paused keyword"),
  z.object({ type: z.literal("pause_campaign"), campaign_id: campaignId }).describe("Pause a whole campaign (stops all its spend)"),
  z.object({ type: z.literal("enable_campaign"), campaign_id: campaignId })
    .describe("Turn a paused campaign back on. It starts spending again; the summary says how much"),
  z.object({ type: z.literal("pause_ad_group"), ad_group_id: adGroupId }).describe("Pause one ad group"),
  z.object({ type: z.literal("enable_ad_group"), ad_group_id: adGroupId }).describe("Re-enable one paused ad group"),
  z.object({
    type: z.literal("set_daily_budget"),
    campaign_id: campaignId,
    amount: z.number().positive().max(1_000_000)
      .describe("New average daily budget in the account's currency, e.g. 10 for $10.00/day (not micros)"),
  }).describe("Change a campaign's daily budget (not shared budgets)"),
  z.object({
    type: z.literal("set_end_date"),
    campaign_id: campaignId,
    end_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"), z.literal("none")])
      .describe('Last day the campaign runs, YYYY-MM-DD in the account\'s time zone (it stops after 23:59:59 that day), or "none" to remove the end date'),
  }).describe("Set the last day a campaign runs, so it stops spending on its own"),
  z.object({
    type: z.literal("create_campaign"),
    name: z.string().min(1).max(255).describe("Campaign name; must not match an existing campaign"),
    daily_budget: z.number().positive().max(1_000_000).describe("Average daily budget in the account's currency, e.g. 20 for $20.00/day"),
    bidding: z.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"]).default("MANUAL_CPC")
      .describe("MANUAL_CPC uses the ad group and keyword max CPCs; MAXIMIZE_CLICKS and MAXIMIZE_CONVERSIONS let Google bid within the budget"),
    max_cpc_ceiling: bid.optional().describe("MAXIMIZE_CLICKS only: the most Google may bid per click"),
    location_ids: z.array(id).min(1).max(50).default(["2840"])
      .describe("Google geo target ids, e.g. 2840 United States, 2826 United Kingdom, 2124 Canada (look others up in geo_target_constant)"),
    language_ids: z.array(id).min(1).max(20).default(["1000"]).describe("Google language ids, e.g. 1000 English, 1003 Spanish"),
    presence_only: z.boolean().default(true).describe("Show ads only to people IN the locations (true), not merely interested in them"),
    search_partners: z.boolean().default(false).describe("Also show on Google's search partner sites"),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("Last day the campaign runs, YYYY-MM-DD"),
    negative_keywords: z.array(negativeSpec).max(200).default([]).describe("Searches to block across the campaign"),
    sitelinks: z.array(sitelinkSpec).max(8).default([]),
    ad_groups: z.array(adGroupSpec).min(1).max(10),
  }).describe("Build a new Search campaign with its ad groups, keywords, ads, targeting, negatives and sitelinks, in one step. It is created PAUSED: nothing spends until a separate enable_campaign"),
  z.object({ type: z.literal("add_ad_group"), campaign_id: campaignId, ad_group: adGroupSpec })
    .describe("Add an ad group, with its keywords and ads, to an existing Search campaign"),
  z.object({ type: z.literal("add_keywords"), ad_group_id: adGroupId, keywords: z.array(keywordSpec).min(1).max(MAX_CHANGES) })
    .describe("Add keywords to an existing ad group"),
  z.object({ type: z.literal("add_responsive_search_ad"), ad_group_id: adGroupId, ad: adSpec })
    .describe("Add a responsive search ad to an existing ad group"),
  z.object({ type: z.literal("add_sitelinks"), campaign_id: campaignId, sitelinks: z.array(sitelinkSpec).min(1).max(8) })
    .describe("Add sitelinks to a campaign"),
  z.object({ type: z.literal("set_conversion_goal"), campaign_id: campaignId, category: goalCategory })
    .describe("Make a campaign count and bid on ONE conversion category only (e.g. SIGNUP), so another product's or step's conversions don't steer it"),
] as const;

/** For propose_changes' input: what the AI sees. */
export const PublicChangeSchema = z.discriminatedUnion("type", [...PUBLIC_CHANGES]);

/** Everything the server accepts, including the change only undo creates. */
export const ChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_CHANGES,
  // Used only by undo: remove what this service created, or restore what it replaced. Not offered to the AI.
  z.object({ type: z.literal("remove_negative_keywords"), campaign_id: id, resource_names: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("remove_campaign"), resource_name: z.string(), name: z.string() }),
  z.object({ type: z.literal("remove_ad_group"), resource_name: z.string(), name: z.string() }),
  z.object({ type: z.literal("remove_keywords"), resource_names: z.array(z.string()).min(1), what: z.string() }),
  z.object({ type: z.literal("remove_ad"), resource_name: z.string(), what: z.string() }),
  z.object({ type: z.literal("remove_campaign_assets"), resource_names: z.array(z.string()).min(1), what: z.string() }),
  z.object({ type: z.literal("restore_conversion_goals"), campaign_id: id, goals: z.array(z.object({ resource_name: z.string(), biddable: z.boolean() })).min(1) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/** A change resolved against the account: the exact API operation plus what it looked like before. */
export interface ResolvedChange {
  change: Change;
  /** "googleAds" = the cross-service atomic mutate, whose operations are MutateOperations. */
  service: "campaignCriteria" | "adGroupCriteria" | "adGroups" | "campaignBudgets" | "campaigns" | "adGroupAds"
    | "campaignConversionGoals" | "googleAds";
  operations: object[];
  describe: string;
  /** Filled at resolve time when the inverse is knowable up front (pause/enable/budget). */
  inverse?: Change;
}


/** Google's stand-in for "no end date". */
const NO_END_DATE_TIME = "2037-12-30 23:59:59";

/** A campaign's end date as YYYY-MM-DD, or "none". */
function endDateOf(endDateTime: string | undefined): string {
  return !endDateTime || endDateTime.startsWith("2037-12-30") ? "none" : endDateTime.slice(0, 10);
}

/**
 * Budgets and end dates a proposal sets for its own campaigns, keyed by campaign id. Each change is
 * resolved against the live account, so without this an "enable campaign" next to a budget change
 * warned about the old budget.
 */
export interface Pending { budgets: Map<string, number>; endDates: Map<string, string> }

export function pendingOf(changes: Change[]): Pending {
  const p: Pending = { budgets: new Map(), endDates: new Map() };
  for (const c of changes) {
    if (c.type === "set_daily_budget") p.budgets.set(c.campaign_id, c.amount);
    if (c.type === "set_end_date") p.endDates.set(c.campaign_id, c.end_date);
  }
  return p;
}

export async function resolveChange(
  ads: Pick<AdsClient, "search">, customerId: string, login: string | null, change: Change,
  pending: Pending = pendingOf([]),
): Promise<ResolvedChange> {
  const q = (query: string) => ads.search(customerId, query, login);
  switch (change.type) {
    case "add_negative_keywords": {
      const [c] = await q(`SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found in account ${customerId}`);
      const existing = await q(`SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion WHERE campaign.id = ${change.campaign_id}
        AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = true`);
      const have = new Set(existing.map((r) =>
        `${String(r.campaignCriterion?.keyword?.text ?? "").toLowerCase()}|${r.campaignCriterion?.keyword?.matchType}`));
      const fresh = change.keywords.filter((k) => !have.has(`${k.text.toLowerCase()}|${k.match_type}`));
      const skipped = change.keywords.length - fresh.length;
      const campaign = `customers/${customerId}/campaigns/${change.campaign_id}`;
      return {
        change: { ...change, keywords: fresh },
        service: "campaignCriteria",
        operations: fresh.map((k) => ({
          create: { campaign, negative: true, keyword: { text: k.text, matchType: k.match_type } },
        })),
        describe: `Add ${fresh.length} negative keyword(s) to campaign "${c.campaign.name}": ` +
          fresh.map((k) => fmtKw(k.text, k.match_type)).join(", ") +
          (skipped ? ` (${skipped} already present, skipped)` : ""),
      };
    }
    case "pause_keyword":
    case "enable_keyword": {
      const [k] = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
          ad_group_criterion.status, ad_group.name, campaign.name
        FROM ad_group_criterion WHERE ad_group.id = ${change.ad_group_id}
        AND ad_group_criterion.criterion_id = ${change.criterion_id}`);
      if (!k) throw new Error(`Keyword ${change.criterion_id} not found in ad group ${change.ad_group_id}`);
      const { ad_group_id, criterion_id } = change;
      return toggle(change, "pause_keyword", "enable_keyword", (type) => ({ type, ad_group_id, criterion_id }), {
        service: "adGroupCriteria", before: k.adGroupCriterion.status,
        resourceName: `customers/${customerId}/adGroupCriteria/${ad_group_id}~${criterion_id}`,
        what: `keyword ${fmtKw(k.adGroupCriterion.keyword.text, k.adGroupCriterion.keyword.matchType)} in ad group "${k.adGroup.name}"`,
        context: `campaign "${k.campaign.name}"`,
      });
    }
    case "pause_campaign":
    case "enable_campaign": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.end_date_time, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const before = c.campaign.status as string;
      if (before === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      // Turning a campaign on is the one change that takes spend from zero to real money: say so in the
      // summary, with the budget and end date it will run under once this proposal is applied.
      const budget = pending.budgets.get(change.campaign_id) ?? micros(c.campaignBudget?.amountMicros);
      const end = pending.endDates.get(change.campaign_id) ?? endDateOf(c.campaign.endDateTime);
      const warn = change.type === "enable_campaign" && before !== "ENABLED"
        ? ` ⚠ it starts spending again, up to an average of ${budget.toFixed(2)}/day` +
          `${c.campaignBudget?.explicitlyShared ? " from a shared budget" : ""}${end === "none" ? "" : ` until ${end}`}`
        : "";
      const { campaign_id } = change;
      return toggle(change, "pause_campaign", "enable_campaign", (type) => ({ type, campaign_id }), {
        service: "campaigns", before, resourceName: `customers/${customerId}/campaigns/${campaign_id}`,
        what: `campaign "${c.campaign.name}"`, warn,
      });
    }
    case "pause_ad_group":
    case "enable_ad_group": {
      const [g] = await q(`SELECT ad_group.name, ad_group.status, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const { ad_group_id } = change;
      return toggle(change, "pause_ad_group", "enable_ad_group", (type) => ({ type, ad_group_id }), {
        service: "adGroups", before: g.adGroup.status, resourceName: `customers/${customerId}/adGroups/${ad_group_id}`,
        what: `ad group "${g.adGroup.name}"`, context: `campaign "${g.campaign.name}"`,
      });
    }
    case "set_daily_budget": {
      const [c] = await q(`SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaignBudget.explicitlyShared) {
        throw new Error(`Campaign "${c.campaign.name}" uses a shared budget; changing it would change every campaign on it. Edit it in Google Ads instead.`);
      }
      const before = micros(c.campaignBudget.amountMicros);
      return {
        change,
        service: "campaignBudgets",
        operations: [{ update: { resourceName: c.campaignBudget.resourceName, amountMicros: toMicros(change.amount) }, updateMask: "amount_micros" }],
        describe: `Set daily budget of campaign "${c.campaign.name}" from ${before.toFixed(2)} to ${change.amount.toFixed(2)}` +
          (before > 0 && change.amount > before * 2 ? ` ⚠ ${(change.amount / before).toFixed(1)}× the current budget` : ""),
        inverse: { type: "set_daily_budget", campaign_id: change.campaign_id, amount: before },
      };
    }
    case "set_end_date": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.end_date_time FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      const before = endDateOf(c.campaign.endDateTime);
      const label = (d: string) => (d === "none" ? "no end date" : d);
      return {
        change,
        service: "campaigns",
        operations: before === change.end_date ? [] : [{
          update: {
            resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`,
            endDateTime: change.end_date === "none" ? NO_END_DATE_TIME : `${change.end_date} 23:59:59`,
          },
          updateMask: "end_date_time",
        }],
        describe: `Set end date of campaign "${c.campaign.name}" from ${label(before)} to ${label(change.end_date)}` +
          (change.end_date === "none" ? "" : " (it stops serving after that day)"),
        inverse: { type: "set_end_date", campaign_id: change.campaign_id, end_date: before },
      };
    }
    case "create_campaign": {
      const c = change;
      const dup = await q(`SELECT campaign.id FROM campaign WHERE campaign.name = '${gaqlStr(c.name)}' AND campaign.status != 'REMOVED'`);
      if (dup.length) throw new Error(`A campaign named "${c.name}" already exists (id ${dup[0].campaign.id}). Pick another name.`);
      if (c.bidding === "MANUAL_CPC") {
        const missing = c.ad_groups.filter((g) => g.default_max_cpc == null && g.keywords.some((k) => k.max_cpc == null));
        if (missing.length) throw new Error(`Manual CPC needs a bid: give default_max_cpc for ad group(s) ${missing.map((g) => `"${g.name}"`).join(", ")}.`);
      }
      if (c.end_date && c.end_date < new Date().toISOString().slice(0, 10)) throw new Error(`End date ${c.end_date} is in the past.`);
      const T = tempIds(customerId);
      const budget = T.next("campaignBudgets"), campaign = T.next("campaigns");
      const ops: object[] = [
        { campaignBudgetOperation: { create: { resourceName: budget, name: `${c.name} budget`, amountMicros: toMicros(c.daily_budget), deliveryMethod: "STANDARD", explicitlyShared: false } } },
        { campaignOperation: { create: {
          resourceName: campaign, name: c.name, status: "PAUSED", campaignBudget: budget, advertisingChannelType: "SEARCH",
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: c.search_partners, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          geoTargetTypeSetting: { positiveGeoTargetType: c.presence_only ? "PRESENCE" : "PRESENCE_OR_INTEREST", negativeGeoTargetType: "PRESENCE" },
          ...(c.bidding === "MANUAL_CPC" ? { manualCpc: { enhancedCpcEnabled: false } }
            : c.bidding === "MAXIMIZE_CLICKS" ? { targetSpend: c.max_cpc_ceiling ? { cpcBidCeilingMicros: toMicros(c.max_cpc_ceiling) } : {} }
            : { maximizeConversions: {} }),
          ...(c.end_date ? { endDateTime: `${c.end_date} 23:59:59` } : {}),
        } } },
        ...c.location_ids.map((g) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
        ...c.language_ids.map((l) => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${l}` } } } })),
        ...c.negative_keywords.map((k) => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: k.text, matchType: k.match_type } } } })),
        ...sitelinkOps(T, campaign, c.sitelinks),
        ...c.ad_groups.flatMap((g) => adGroupOps(T, campaign, g)),
      ];
      const places = await names(q, "geo_target_constant", "canonical_name", c.location_ids.map((g) => `geoTargetConstants/${g}`));
      const langs = await names(q, "language_constant", "name", c.language_ids.map((l) => `languageConstants/${l}`));
      const bidding = c.bidding === "MANUAL_CPC" ? "manual CPC" : c.bidding === "MAXIMIZE_CLICKS"
        ? `maximize clicks${c.max_cpc_ceiling ? ` (max ${c.max_cpc_ceiling.toFixed(2)}/click)` : ""}` : "maximize conversions";
      const groups = c.ad_groups.map((g) => `"${g.name}" (${g.keywords.length} keyword(s)${g.default_max_cpc ? `, bid ${g.default_max_cpc.toFixed(2)}` : ""}, ${g.ads.length} ad(s) → ${g.ads[0]!.final_url})`);
      return {
        change, service: "googleAds", operations: ops,
        describe: `Create Search campaign "${c.name}", PAUSED (nothing spends until you enable it): ${c.daily_budget.toFixed(2)}/day, ${bidding}, ` +
          `${places.join(", ")}${c.presence_only ? " (people in the location)" : ""}, ${langs.join(", ")}` +
          `${c.end_date ? `, ends ${c.end_date}` : ""}${c.search_partners ? ", plus search partners" : ""}; ` +
          `${c.ad_groups.length} ad group(s): ${groups.join("; ")}` +
          `${c.negative_keywords.length ? `; ${c.negative_keywords.length} negative keyword(s)` : ""}` +
          `${c.sitelinks.length ? `; ${c.sitelinks.length} sitelink(s)` : ""}` +
          (c.daily_budget >= 100 ? ` ⚠ budget ${c.daily_budget.toFixed(2)}/day` : ""),
      };
    }
    case "add_ad_group": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      if (c.campaign.advertisingChannelType !== "SEARCH") throw new Error(`Campaign "${c.campaign.name}" isn't a Search campaign; ad groups can only be added to Search campaigns here.`);
      const g = change.ad_group;
      if (c.campaign.biddingStrategyType === "MANUAL_CPC" && g.default_max_cpc == null && g.keywords.some((k) => k.max_cpc == null)) {
        throw new Error(`Campaign "${c.campaign.name}" uses manual CPC: give the ad group a default_max_cpc.`);
      }
      const T = tempIds(customerId);
      return {
        change, service: "googleAds",
        operations: adGroupOps(T, `customers/${customerId}/campaigns/${change.campaign_id}`, g),
        describe: `Add ad group "${g.name}" to campaign "${c.campaign.name}": ${g.keywords.length} keyword(s)` +
          `${g.default_max_cpc ? `, bid ${g.default_max_cpc.toFixed(2)}` : ""}, ${g.ads.length} ad(s) → ${g.ads[0]!.final_url}` +
          (c.campaign.status === "ENABLED" ? " ⚠ the campaign is on, so this starts serving once Google approves the ads" : ""),
      };
    }
    case "add_keywords": {
      const [g] = await q(`SELECT ad_group.name, campaign.name, campaign.status FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const existing = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion
        WHERE ad_group.id = ${change.ad_group_id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
        AND ad_group_criterion.status != 'REMOVED'`);
      const have = new Set(existing.map((r) => `${String(r.adGroupCriterion?.keyword?.text ?? "").toLowerCase()}|${r.adGroupCriterion?.keyword?.matchType}`));
      const fresh = change.keywords.filter((k) => !have.has(`${k.text.toLowerCase()}|${k.match_type}`));
      const skipped = change.keywords.length - fresh.length;
      const adGroup = `customers/${customerId}/adGroups/${change.ad_group_id}`;
      return {
        change: { ...change, keywords: fresh }, service: "adGroupCriteria",
        operations: fresh.map((k) => ({ create: keywordCreate(adGroup, k) })),
        describe: `Add ${fresh.length} keyword(s) to ad group "${g.adGroup.name}" (campaign "${g.campaign.name}"): ` +
          fresh.map((k) => fmtKw(k.text, k.match_type) + (k.max_cpc ? ` @ ${k.max_cpc.toFixed(2)}` : "")).join(", ") +
          (skipped ? ` (${skipped} already present, skipped)` : ""),
      };
    }
    case "add_responsive_search_ad": {
      const [g] = await q(`SELECT ad_group.name, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      return {
        change, service: "adGroupAds",
        operations: [{ create: adCreate(`customers/${customerId}/adGroups/${change.ad_group_id}`, change.ad) }],
        describe: `Add a responsive search ad to ad group "${g.adGroup.name}" (campaign "${g.campaign.name}"): ` +
          `${change.ad.headlines.length} headlines, ${change.ad.descriptions.length} descriptions → ${change.ad.final_url}`,
      };
    }
    case "add_sitelinks": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const T = tempIds(customerId);
      return {
        change, service: "googleAds",
        operations: sitelinkOps(T, `customers/${customerId}/campaigns/${change.campaign_id}`, change.sitelinks),
        describe: `Add ${change.sitelinks.length} sitelink(s) to campaign "${c.campaign.name}": ${change.sitelinks.map((x) => `"${x.text}"`).join(", ")}`,
      };
    }
    case "set_conversion_goal": {
      const rows = await q(`SELECT campaign.name, campaign_conversion_goal.resource_name, campaign_conversion_goal.category,
          campaign_conversion_goal.origin, campaign_conversion_goal.biddable
        FROM campaign_conversion_goal WHERE campaign.id = ${change.campaign_id}`);
      if (!rows.length) throw new Error(`Campaign ${change.campaign_id} not found, or it has no conversion goals yet`);
      const cats = [...new Set(rows.map((r) => r.campaignConversionGoal.category as string))];
      if (!cats.includes(change.category)) {
        throw new Error(`No ${change.category} goal on this campaign. The account's conversion actions give it: ${cats.join(", ")}.`);
      }
      const flips = rows.filter((r) => !!r.campaignConversionGoal.biddable !== (r.campaignConversionGoal.category === change.category));
      const before = [...new Set(rows.filter((r) => r.campaignConversionGoal.biddable).map((r) => r.campaignConversionGoal.category as string))];
      return {
        change, service: "campaignConversionGoals",
        operations: flips.map((r) => ({
          update: { resourceName: r.campaignConversionGoal.resourceName, biddable: r.campaignConversionGoal.category === change.category },
          updateMask: "biddable",
        })),
        describe: `Campaign "${rows[0].campaign.name}" counts and bids on ${change.category} conversions only (was: ${before.join(", ") || "none"})`,
        inverse: flips.length ? {
          type: "restore_conversion_goals", campaign_id: change.campaign_id,
          goals: flips.map((r) => ({ resource_name: r.campaignConversionGoal.resourceName, biddable: !!r.campaignConversionGoal.biddable })),
        } : undefined,
      };
    }
    case "restore_conversion_goals": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      return {
        change, service: "campaignConversionGoals",
        operations: change.goals.map((g) => ({ update: { resourceName: g.resource_name, biddable: g.biddable }, updateMask: "biddable" })),
        describe: `Restore the conversion goals campaign ${c ? `"${c.campaign.name}"` : change.campaign_id} bid on before`,
      };
    }
    case "remove_campaign":
      return {
        change, service: "campaigns", operations: [{ remove: change.resource_name }],
        describe: `Remove campaign "${change.name}" that Camberstack created ⚠ a removed campaign can't be restored; to only stop spending, pause it instead`,
      };
    case "remove_ad_group":
      return { change, service: "adGroups", operations: [{ remove: change.resource_name }], describe: `Remove ad group "${change.name}" that Camberstack created` };
    case "remove_keywords":
      return { change, service: "adGroupCriteria", operations: change.resource_names.map((r) => ({ remove: r })), describe: `Remove ${change.what}` };
    case "remove_ad":
      return { change, service: "adGroupAds", operations: [{ remove: change.resource_name }], describe: `Remove ${change.what}` };
    case "remove_campaign_assets":
      return { change, service: "googleAds", operations: change.resource_names.map((r) => ({ campaignAssetOperation: { remove: r } })), describe: `Remove ${change.what}` };
    case "remove_negative_keywords": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      const name = c ? `"${c.campaign.name}"` : change.campaign_id;
      return {
        change,
        service: "campaignCriteria",
        operations: change.resource_names.map((r) => ({ remove: r })),
        describe: `Remove ${change.resource_names.length} negative keyword(s) previously added to campaign ${name}`,
      };
    }
  }
}

/** GAQL string literal body: escape backslashes and single quotes. */
function gaqlStr(v: string): string { return v.replace(/[\\']/g, "\\$&"); }

/**
 * Temporary resource names for one googleAds:mutate: negative ids that later operations in the same
 * request can reference, so a whole campaign is created atomically (all or nothing).
 */
function tempIds(customerId: string) {
  let n = 0;
  return { next: (collection: string) => `customers/${customerId}/${collection}/${--n}` };
}

function keywordCreate(adGroup: string, k: { text: string; match_type: string; max_cpc?: number }) {
  return { adGroup, status: "ENABLED", keyword: { text: k.text, matchType: k.match_type }, ...(k.max_cpc ? { cpcBidMicros: toMicros(k.max_cpc) } : {}) };
}

function adCreate(adGroup: string, a: { headlines: string[]; descriptions: string[]; final_url: string; path1?: string; path2?: string }) {
  return {
    adGroup, status: "ENABLED",
    ad: { finalUrls: [a.final_url], responsiveSearchAd: {
      headlines: a.headlines.map((text) => ({ text })), descriptions: a.descriptions.map((text) => ({ text })),
      ...(a.path1 ? { path1: a.path1 } : {}), ...(a.path2 ? { path2: a.path2 } : {}),
    } },
  };
}

type AdGroupSpec = z.infer<typeof adGroupSpec>;
function adGroupOps(T: ReturnType<typeof tempIds>, campaign: string, g: AdGroupSpec): object[] {
  const adGroup = T.next("adGroups");
  return [
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: g.name, status: "ENABLED", type: "SEARCH_STANDARD",
      ...(g.default_max_cpc ? { cpcBidMicros: toMicros(g.default_max_cpc) } : {}) } } },
    ...g.ads.map((a) => ({ adGroupAdOperation: { create: adCreate(adGroup, a) } })),
    ...g.keywords.map((k) => ({ adGroupCriterionOperation: { create: keywordCreate(adGroup, k) } })),
  ];
}

type SitelinkSpec = z.infer<typeof sitelinkSpec>;
function sitelinkOps(T: ReturnType<typeof tempIds>, campaign: string, links: SitelinkSpec[]): object[] {
  return links.flatMap((l) => {
    if (!!l.description1 !== !!l.description2) throw new Error(`Sitelink "${l.text}": give both descriptions or neither.`);
    const asset = T.next("assets");
    return [
      { assetOperation: { create: { resourceName: asset, finalUrls: [l.url], sitelinkAsset: {
        linkText: l.text, ...(l.description1 ? { description1: l.description1, description2: l.description2 } : {}) } } } },
      { campaignAssetOperation: { create: { asset, campaign, fieldType: "SITELINK" } } },
    ];
  });
}

/** Human names for geo or language constants; falls back to the ids if they can't be read. */
async function names(q: (query: string) => Promise<any[]>, resource: string, field: string, rns: string[]): Promise<string[]> {
  try {
    const rows = await q(`SELECT ${resource}.resource_name, ${resource}.${field} FROM ${resource}
      WHERE ${resource}.resource_name IN (${rns.map((r) => `'${r}'`).join(", ")})`);
    const key = resource.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    const by = new Map(rows.map((r) => [r[key]?.resourceName, r[key]?.[field === "canonical_name" ? "canonicalName" : field]]));
    return rns.map((r) => by.get(r) ?? r.split("/").pop()!);
  } catch {
    return rns.map((r) => r.split("/").pop()!);
  }
}

/**
 * A pause or enable: one status update, skipped when the target is already in place, whose inverse is
 * the opposite change.
 */
function toggle<P extends Change["type"], E extends Change["type"]>(
  change: Change, pause: P, enable: E, make: (type: P | E) => Change,
  o: { service: ResolvedChange["service"]; before: string; resourceName: string; what: string; context?: string; warn?: string },
): ResolvedChange {
  const pausing = change.type === pause;
  const target = pausing ? "PAUSED" : "ENABLED";
  const same = o.before === target;
  return {
    change,
    service: o.service,
    operations: same ? [] : [{ update: { resourceName: o.resourceName, status: target }, updateMask: "status" }],
    describe: `${pausing ? "Pause" : "Enable"} ${o.what} (${o.context ? `${o.context}; ` : ""}now ${o.before})${o.warn ?? ""}`,
    inverse: same ? undefined : make(pausing ? enable : pause),
  };
}

/** Inverse of an applied change, given the resource names the API returned. */
export function inverseAfterApply(r: ResolvedChange, resourceNames: string[]): Change | undefined {
  const c = r.change;
  const of = (collection: string) => resourceNames.filter((n) => n.includes(`/${collection}/`));
  if (c.type === "add_negative_keywords" && resourceNames.length) {
    return { type: "remove_negative_keywords", campaign_id: c.campaign_id, resource_names: resourceNames };
  }
  // Undo of a build removes the top of what was built; Google removes what hangs off it.
  if (c.type === "create_campaign" && of("campaigns")[0]) return { type: "remove_campaign", resource_name: of("campaigns")[0]!, name: c.name };
  if (c.type === "add_ad_group" && of("adGroups")[0]) return { type: "remove_ad_group", resource_name: of("adGroups")[0]!, name: c.ad_group.name };
  if (c.type === "add_keywords" && resourceNames.length) {
    return { type: "remove_keywords", resource_names: resourceNames, what: `${resourceNames.length} keyword(s) Camberstack added: ${c.keywords.map((k) => fmtKw(k.text, k.match_type)).join(", ")}` };
  }
  if (c.type === "add_responsive_search_ad" && resourceNames[0]) {
    return { type: "remove_ad", resource_name: resourceNames[0], what: `the responsive search ad Camberstack added (→ ${c.ad.final_url})` };
  }
  if (c.type === "add_sitelinks" && of("campaignAssets").length) {
    return { type: "remove_campaign_assets", resource_names: of("campaignAssets"), what: `${c.sitelinks.length} sitelink(s) Camberstack added: ${c.sitelinks.map((x) => `"${x.text}"`).join(", ")}` };
  }
  return r.inverse;
}

export function fmtKw(text: string, matchType: string): string {
  return matchType === "EXACT" ? `[${text}]` : matchType === "PHRASE" ? `"${text}"` : text;
}

export function summarize(resolved: ResolvedChange[]): string {
  return resolved.filter((r) => r.operations.length)
    .map((r, i) => `${i + 1}. ${r.describe}`).join("\n");
}
