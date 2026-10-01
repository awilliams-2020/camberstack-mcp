/**
 * Pure functions that turn Google Ads rows into a waste diagnosis. No I/O, so they are tested
 * directly against fixtures.
 *
 * The method, in order:
 *   1. Check conversion tracking FIRST. Without trustworthy conversions, "zero conversions" means
 *      nothing and every waste call would be a guess. A common silent failure: a PAGE_VIEW action
 *      set as primary, so a landing-page view counts as a conversion.
 *   2. Campaigns first: a campaign that spent more than a conversion's worth with zero conversions
 *      is the biggest, most certain leak, and no per-term view shows it.
 *   3. Then search terms, against their OWN campaign's cost per conversion (an account mixing a $50
 *      and a $300 product has no meaningful single CPA): a term that spent a whole conversion's
 *      worth with nothing to show is worth a look.
 *   4. Low-intent patterns ("free", jobs, how-to, login) are proposed as phrase negatives only when
 *      they burned money AND no search term containing them converted. If "free X" converts for
 *      you, blocking "free" would cut working traffic.
 */

export interface SearchTermRow {
  term: string;
  campaignId: string;
  campaignName: string;
  cost: number;        // account currency units, not micros
  clicks: number;
  conversions: number;
}

export interface KeywordRow {
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  criterionId: string;
  text: string;
  matchType: string;
  status: string;
  cost: number;
  clicks: number;
  conversions: number;
}

export interface CampaignRow {
  campaignId: string;
  name: string;
  type: string;
  status: string;
  cost: number;
  clicks: number;
  conversions: number;
}

export interface ConversionActionRow {
  id: string;
  name: string;
  category: string;
  status: string;
  primaryForGoal: boolean;
  type: string;
}

export interface TrackingCheck {
  status: "ok" | "warning" | "broken";
  notes: string[];
}

export function checkTracking(actions: ConversionActionRow[], totalCost: number, totalConversions: number): TrackingCheck {
  const notes: string[] = [];
  const live = actions.filter((a) => a.status === "ENABLED");
  const primary = live.filter((a) => a.primaryForGoal);
  if (!live.length) {
    return { status: "broken", notes: ["No enabled conversion actions. Google cannot tell a good click from a bad one; fix tracking before cutting anything."] };
  }
  if (!primary.length) {
    return { status: "broken", notes: ["Conversion actions exist but none is primary, so the Conversions column is always 0."] };
  }
  let status: TrackingCheck["status"] = "ok";
  const pageViews = primary.filter((a) => a.category === "PAGE_VIEW");
  if (pageViews.length) {
    status = "warning";
    notes.push(`Primary conversion action(s) counting page views: ${pageViews.map((a) => `"${a.name}"`).join(", ")}. A page view is usually not a sale or lead, so Conversions (and Smart Bidding) may be inflated.`);
  }
  if (totalConversions === 0 && totalCost > 100) {
    status = "warning";
    notes.push(`${fmt(totalCost)} spent with 0 conversions. Either the ads truly produce nothing, or the tag is not firing. Test a conversion yourself before pausing anything.`);
  }
  if (status === "ok") notes.push(`${primary.length} primary conversion action(s): ${primary.map((a) => `"${a.name}" (${a.category})`).join(", ")}.`);
  return { status, notes };
}

export const LOW_INTENT: { token: string; why: string; re: RegExp }[] = [
  { token: "free", why: "looking for a free option", re: /\bfree\b/i },
  // Plural "jobs" only: "job costing software" and "job management app" are buyers.
  { token: "jobs", why: "job seekers", re: /\b(jobs|careers?|hiring|salary|salaries|internships?)\b/i },
  { token: "how to", why: "research / DIY", re: /\bhow to\b/i },
  { token: "what is", why: "definitions", re: /\b(what is|meaning|definition)\b/i },
  { token: "tutorial", why: "learning, not buying", re: /\b(tutorial|course|courses|training)\b/i },
  { token: "login", why: "existing users of another product", re: /\b(log ?in|sign ?in)\b/i },
  { token: "diy", why: "do-it-yourself", re: /\bdiy\b/i },
];

export interface WastedTerm extends SearchTermRow {
  reason: string;
}

export interface NegativeSuggestion {
  campaignId: string;
  campaignName: string;
  text: string;
  matchType: "EXACT" | "PHRASE";
  cost: number;
  why: string;
}

export interface WasteReport {
  window: string;
  currency: string;
  totals: { cost: number; clicks: number; conversions: number; costPerConversion: number | null };
  zeroConversionSpend: { cost: number; share: number; terms: number };
  tracking: TrackingCheck;
  campaignsToReview: (CampaignRow & { reason: string })[];
  topWastedTerms: WastedTerm[];
  /** The biggest zero-conversion terms regardless of threshold, for context. */
  zeroConversionTerms: SearchTermRow[];
  lowIntent: { token: string; why: string; cost: number; terms: number; examples: string[]; convertedAnyway: boolean }[];
  suggestedNegatives: NegativeSuggestion[];
  keywordsToReview: (KeywordRow & { reason: string })[];
  caveats: string[];
}

export function analyzeWaste(input: {
  window: string;
  currency: string;
  terms: SearchTermRow[];
  keywords: KeywordRow[];
  campaigns: CampaignRow[];
  actions: ConversionActionRow[];
  existingNegatives: Set<string>; // `${campaignId}|${text.toLowerCase()}|${matchType}`
}): WasteReport {
  const { terms, keywords, campaigns } = input;
  // Campaign rows are authoritative for totals: search terms miss Performance Max and hidden terms.
  const totalCost = campaigns.length ? sum(campaigns.map((c) => c.cost)) : Math.max(sum(terms.map((t) => t.cost)), sum(keywords.map((k) => k.cost)));
  const conversions = campaigns.length ? sum(campaigns.map((c) => c.conversions)) : sum(terms.map((t) => t.conversions));
  const clicks = campaigns.length ? sum(campaigns.map((c) => c.clicks)) : sum(terms.map((t) => t.clicks));
  const cost = sum(terms.map((t) => t.cost));
  const cpa = conversions > 0 ? totalCost / conversions : null;
  const tracking = checkTracking(input.actions, totalCost, conversions);
  const caveats: string[] = [];

  const campaignCpa = new Map<string, number>();
  for (const c of campaigns) if (c.conversions > 0) campaignCpa.set(c.campaignId, c.cost / c.conversions);

  const campaignBar = cpa !== null ? Math.max(cpa, 50) : 100;
  const campaignsToReview = campaigns
    .filter((c) => c.conversions === 0 && c.cost >= campaignBar)
    .sort((a, b) => b.cost - a.cost)
    .map((c) => ({ ...c, cost: round(c.cost), reason: (cpa !== null
      ? `spent ${fmt(c.cost)} (${(c.cost / cpa).toFixed(1)}× the account's cost per conversion) with 0 conversions`
      : `spent ${fmt(c.cost)} with 0 conversions`)
      + (c.status === "ENABLED" ? ". The campaign itself is the problem: consider pausing it (pause_campaign) or reworking it, rather than blocking its searches one by one" : "") }));

  const zero = terms.filter((t) => t.conversions === 0 && t.cost > 0);
  const zeroCost = sum(zero.map((t) => t.cost));

  // A term is "wasted" when it spent at least one conversion's worth of ITS campaign (account CPA
  // when the campaign has none; $10 floor) with no conversions.
  const wasted = zero
    .map((t) => {
      const ref = campaignCpa.get(t.campaignId) ?? cpa;
      return { t, ref, bar: ref !== null ? Math.max(ref, 10) : 10 };
    })
    .filter(({ t, ref, bar }) => t.cost >= bar && t.clicks >= (ref !== null ? 1 : 5))
    .sort((a, b) => b.t.cost - a.t.cost)
    .map(({ t, ref }) => ({
      ...t,
      reason: ref !== null
        ? `spent ${fmt(t.cost)} (${(t.cost / ref).toFixed(1)}× ${campaignCpa.has(t.campaignId) ? "its campaign's" : "the account's"} cost per conversion) with 0 conversions`
        : `spent ${fmt(t.cost)} on ${t.clicks} clicks with 0 conversions`,
    }));

  const lowIntent = LOW_INTENT.map((p) => {
    const hits = terms.filter((t) => p.re.test(t.term));
    return {
      token: p.token,
      why: p.why,
      cost: sum(hits.filter((t) => t.conversions === 0).map((t) => t.cost)),
      terms: hits.length,
      examples: hits.sort((a, b) => b.cost - a.cost).slice(0, 3).map((t) => t.term),
      convertedAnyway: hits.some((t) => t.conversions > 0),
    };
  }).filter((x) => x.terms > 0 && x.cost > 0).sort((a, b) => b.cost - a.cost);

  const suggested: NegativeSuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: NegativeSuggestion) => {
    const key = `${s.campaignId}|${s.text.toLowerCase()}|${s.matchType}`;
    if (seen.has(key) || input.existingNegatives.has(key)) return;
    seen.add(key);
    suggested.push(s);
  };
  // Phrase negatives for low-intent tokens, per campaign, only where that token never converted in
  // that campaign (a converting "free trial" in one campaign says nothing about another).
  for (const li of lowIntent) {
    const p = LOW_INTENT.find((q) => q.token === li.token)!;
    const byCampaign = groupBy(terms.filter((t) => p.re.test(t.term)), (t) => t.campaignId);
    for (const [cid, all] of byCampaign) {
      if (all.some((t) => t.conversions > 0)) continue;
      const rows = all.filter((t) => t.conversions === 0);
      const c = sum(rows.map((r) => r.cost));
      if (c < 5) continue;
      const token = p.token === "jobs" ? "jobs" : p.token;
      add({ campaignId: cid, campaignName: rows[0]!.campaignName, text: token, matchType: "PHRASE", cost: c,
        why: `${rows.length} search term(s) with "${token}" (${p.why}) cost ${fmt(c)}, none converted` });
    }
  }
  // Exact negatives for the individually expensive terms, except where a negative is the wrong tool:
  //  - the campaign converts nothing at all: it's in campaignsToReview, and blocking its searches one by
  //    one only shrinks it (the demo's "drain cleaning" negative on the Drain Cleaning campaign);
  //  - the search IS one of the campaign's own keywords: a negative would cancel that keyword, so the
  //    honest call is to review the keyword (keywordsToReview), not to block it from underneath.
  const reviewCampaigns = new Set(campaignsToReview.map((c) => c.campaignId));
  const ownKeywords = new Set(input.keywords.filter((k) => k.status === "ENABLED").map((k) => `${k.campaignId}|${k.text.toLowerCase()}`));
  for (const w of wasted.slice(0, 25)) {
    if (reviewCampaigns.has(w.campaignId) || ownKeywords.has(`${w.campaignId}|${w.term.toLowerCase()}`)) continue;
    add({ campaignId: w.campaignId, campaignName: w.campaignName, text: w.term, matchType: "EXACT", cost: w.cost, why: w.reason });
  }
  suggested.sort((a, b) => b.cost - a.cost);

  const keywordsToReview = keywords
    .filter((k) => k.status === "ENABLED" && k.conversions === 0 && k.cost >= (cpa !== null ? Math.max(2 * cpa, 20) : 50))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20)
    .map((k) => ({ ...k, reason: cpa !== null
      ? `spent ${fmt(k.cost)} (${(k.cost / cpa).toFixed(1)}× cost per conversion), 0 conversions`
      : `spent ${fmt(k.cost)}, 0 conversions` }));

  const pmax = campaigns.filter((c) => c.type === "PERFORMANCE_MAX" && c.cost > 0);
  if (pmax.length) caveats.push(`${fmt(sum(pmax.map((c) => c.cost)))} of spend is in Performance Max, which reports no per-search-term data here; judge it at the campaign level.`);
  if (tracking.status !== "ok") caveats.push("Conversion tracking is not trustworthy (see tracking). Treat every zero-conversion call below as provisional.");
  if (!terms.length) caveats.push("No search-term data in this window. Performance Max and Display campaigns don't report per-query terms here.");
  caveats.push("Search terms below Google's privacy threshold are hidden, so zero-conversion spend is a lower bound.");

  return {
    window: input.window,
    currency: input.currency,
    totals: { cost: round(totalCost), clicks, conversions: round(conversions), costPerConversion: cpa !== null ? round(cpa) : null },
    zeroConversionSpend: { cost: round(zeroCost), share: cost > 0 ? round(zeroCost / cost) : 0, terms: zero.length },
    tracking,
    campaignsToReview,
    topWastedTerms: wasted.slice(0, 25).map((t) => ({ ...t, cost: round(t.cost) })),
    zeroConversionTerms: zero.sort((a, b) => b.cost - a.cost).slice(0, 15).map((t) => ({ ...t, cost: round(t.cost) })),
    lowIntent: lowIntent.map((l) => ({ ...l, cost: round(l.cost) })),
    suggestedNegatives: suggested.slice(0, 40).map((s) => ({ ...s, cost: round(s.cost) })),
    keywordsToReview,
    caveats,
  };
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const round = (x: number) => Math.round(x * 100) / 100;
export const fmt = (x: number) => `$${x.toFixed(2)}`;
function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}
