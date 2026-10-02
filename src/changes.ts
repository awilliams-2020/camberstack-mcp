/**
 * The only way this service writes to a Google Ads account.
 *
 *   propose  → resolve every change against the live account, dry-run it with validateOnly, store
 *              it with a plain-English diff. Nothing is written.
 *   apply    → only a stored, un-applied proposal belonging to this user, less than 24h old. Each
 *              change records its inverse, so any applied proposal can be undone.
 *
 * Deliberately small surface: negatives, pause/enable keyword, pause/enable ad group, daily budget.
 * No creating campaigns, no bid strategy changes, no deleting anything a user built.
 */
import { z } from "zod";
import { micros, toMicros, type AdsClient } from "./google.js";

export const MAX_CHANGES = 50;
export const PROPOSAL_TTL = 24 * 3600;

const id = z.string().regex(/^\d+$/, "numeric id");
const campaignId = id.describe("Campaign id, digits only (campaign_id from account_overview or find_wasted_spend)");
const adGroupId = id.describe("Ad group id, digits only (ad_group.id from run_gaql)");
const criterionId = id.describe("Keyword criterion id, digits only (ad_group_criterion.criterion_id from run_gaql)");

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
] as const;

/** For propose_changes' input: what the AI sees. */
export const PublicChangeSchema = z.discriminatedUnion("type", [...PUBLIC_CHANGES]);

/** Everything the server accepts, including the change only undo creates. */
export const ChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_CHANGES,
  // Used only by undo: remove negatives this service created. Not offered to the AI.
  z.object({ type: z.literal("remove_negative_keywords"), campaign_id: id, resource_names: z.array(z.string()).min(1) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/** A change resolved against the account: the exact API operation plus what it looked like before. */
export interface ResolvedChange {
  change: Change;
  service: "campaignCriteria" | "adGroupCriteria" | "adGroups" | "campaignBudgets" | "campaigns";
  operations: object[];
  describe: string;
  /** Filled at resolve time when the inverse is knowable up front (pause/enable/budget). */
  inverse?: Change;
}


export async function resolveChange(
  ads: Pick<AdsClient, "search">, customerId: string, login: string | null, change: Change,
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
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const before = c.campaign.status as string;
      if (before === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      // Turning a campaign on is the one change that takes spend from zero to real money: say so in the summary.
      const warn = change.type === "enable_campaign" && before !== "ENABLED"
        ? ` ⚠ it starts spending again, up to an average of ${micros(c.campaignBudget?.amountMicros).toFixed(2)}/day${c.campaignBudget?.explicitlyShared ? " from a shared budget" : ""}`
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
  if (r.change.type === "add_negative_keywords" && resourceNames.length) {
    return { type: "remove_negative_keywords", campaign_id: r.change.campaign_id, resource_names: resourceNames };
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
