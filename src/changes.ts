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
import type { AdsClient } from "./google.js";

export const MAX_CHANGES = 50;
export const PROPOSAL_TTL = 24 * 3600;

const id = z.string().regex(/^\d+$/, "numeric id");

export const ChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_negative_keywords"),
    campaign_id: id,
    keywords: z.array(z.object({
      text: z.string().min(1).max(80),
      match_type: z.enum(["EXACT", "PHRASE", "BROAD"]),
    })).min(1).max(MAX_CHANGES),
  }),
  z.object({ type: z.literal("pause_keyword"), ad_group_id: id, criterion_id: id }),
  z.object({ type: z.literal("enable_keyword"), ad_group_id: id, criterion_id: id }),
  z.object({ type: z.literal("pause_ad_group"), ad_group_id: id }),
  z.object({ type: z.literal("enable_ad_group"), ad_group_id: id }),
  z.object({ type: z.literal("set_daily_budget"), campaign_id: id, amount: z.number().positive().max(1_000_000) }),
  // Used only by undo: remove negatives this service created.
  z.object({ type: z.literal("remove_negative_keywords"), campaign_id: id, resource_names: z.array(z.string()).min(1) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/** A change resolved against the account: the exact API operation plus what it looked like before. */
export interface ResolvedChange {
  change: Change;
  service: "campaignCriteria" | "adGroupCriteria" | "adGroups" | "campaignBudgets";
  operations: object[];
  describe: string;
  /** Filled at resolve time when the inverse is knowable up front (pause/enable/budget). */
  inverse?: Change;
}

const toMicros = (x: number) => String(Math.round(x * 1_000_000));
const fromMicros = (m: unknown) => Number(m ?? 0) / 1_000_000;

export async function resolveChange(
  ads: AdsClient, customerId: string, login: string | null, change: Change,
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
      const target = change.type === "pause_keyword" ? "PAUSED" : "ENABLED";
      const before = k.adGroupCriterion.status as string;
      return {
        change,
        service: "adGroupCriteria",
        operations: [{
          update: { resourceName: `customers/${customerId}/adGroupCriteria/${change.ad_group_id}~${change.criterion_id}`, status: target },
          updateMask: "status",
        }],
        describe: `${target === "PAUSED" ? "Pause" : "Enable"} keyword ${fmtKw(k.adGroupCriterion.keyword.text, k.adGroupCriterion.keyword.matchType)} ` +
          `in ad group "${k.adGroup.name}" (campaign "${k.campaign.name}"; now ${before})`,
        inverse: before === target ? undefined
          : { type: target === "PAUSED" ? "enable_keyword" : "pause_keyword", ad_group_id: change.ad_group_id, criterion_id: change.criterion_id },
      };
    }
    case "pause_ad_group":
    case "enable_ad_group": {
      const [g] = await q(`SELECT ad_group.name, ad_group.status, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const target = change.type === "pause_ad_group" ? "PAUSED" : "ENABLED";
      const before = g.adGroup.status as string;
      return {
        change,
        service: "adGroups",
        operations: [{ update: { resourceName: `customers/${customerId}/adGroups/${change.ad_group_id}`, status: target }, updateMask: "status" }],
        describe: `${target === "PAUSED" ? "Pause" : "Enable"} ad group "${g.adGroup.name}" (campaign "${g.campaign.name}"; now ${before})`,
        inverse: before === target ? undefined
          : { type: target === "PAUSED" ? "enable_ad_group" : "pause_ad_group", ad_group_id: change.ad_group_id },
      };
    }
    case "set_daily_budget": {
      const [c] = await q(`SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaignBudget.explicitlyShared) {
        throw new Error(`Campaign "${c.campaign.name}" uses a shared budget; changing it would change every campaign on it. Edit it in Google Ads instead.`);
      }
      const before = fromMicros(c.campaignBudget.amountMicros);
      return {
        change,
        service: "campaignBudgets",
        operations: [{ update: { resourceName: c.campaignBudget.resourceName, amountMicros: toMicros(change.amount) }, updateMask: "amount_micros" }],
        describe: `Set daily budget of campaign "${c.campaign.name}" from ${before.toFixed(2)} to ${change.amount.toFixed(2)}` +
          (change.amount > before * 2 ? " ⚠ more than doubles it" : ""),
        inverse: { type: "set_daily_budget", campaign_id: change.campaign_id, amount: before },
      };
    }
    case "remove_negative_keywords":
      return {
        change,
        service: "campaignCriteria",
        operations: change.resource_names.map((r) => ({ remove: r })),
        describe: `Remove ${change.resource_names.length} negative keyword(s) previously added to campaign ${change.campaign_id}`,
      };
  }
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
