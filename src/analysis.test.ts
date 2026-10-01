import { describe, expect, it } from "vitest";
import { analyzeWaste, checkTracking, type ConversionActionRow, type SearchTermRow } from "./analysis.js";

const purchase: ConversionActionRow = { id: "1", name: "Purchase", category: "PURCHASE", status: "ENABLED", primaryForGoal: true, type: "WEBPAGE" };
const t = (term: string, cost: number, clicks: number, conversions: number, campaignId = "10"): SearchTermRow =>
  ({ term, campaignId, campaignName: "Search", cost, clicks, conversions });

describe("checkTracking", () => {
  it("is broken with no enabled actions", () => {
    expect(checkTracking([], 500, 0).status).toBe("broken");
  });
  it("is broken when nothing is primary", () => {
    expect(checkTracking([{ ...purchase, primaryForGoal: false }], 500, 0).status).toBe("broken");
  });
  it("warns when a page view counts as a primary conversion", () => {
    const r = checkTracking([purchase, { ...purchase, id: "2", name: "Visited pricing", category: "PAGE_VIEW" }], 500, 10);
    expect(r.status).toBe("warning");
    expect(r.notes.join(" ")).toContain("Visited pricing");
  });
  it("warns on real spend with zero conversions", () => {
    expect(checkTracking([purchase], 250, 0).status).toBe("warning");
  });
  it("is ok otherwise", () => {
    expect(checkTracking([purchase], 250, 5).status).toBe("ok");
  });
});

describe("analyzeWaste", () => {
  const base = { window: "last 30 days", currency: "USD", keywords: [], campaigns: [], actions: [purchase], existingNegatives: new Set<string>() };

  it("flags terms that spent a conversion's worth with none, using the account's own CPA", () => {
    // 200 spent, 4 conversions → CPA 50. "bad term" spent 60 (≥ CPA) with 0 conv; "meh" spent 20.
    const r = analyzeWaste({ ...base, terms: [t("good term", 120, 30, 4), t("bad term", 60, 12, 0), t("meh", 20, 5, 0)] });
    expect(r.totals.costPerConversion).toBe(50);
    expect(r.topWastedTerms.map((x) => x.term)).toEqual(["bad term"]);
    expect(r.suggestedNegatives).toContainEqual(expect.objectContaining({ text: "bad term", matchType: "EXACT" }));
    expect(r.zeroConversionSpend.cost).toBe(80);
  });

  it("proposes a phrase negative for a low-intent token that never converted", () => {
    const r = analyzeWaste({ ...base, terms: [t("invoice app", 100, 20, 2), t("free invoice maker", 15, 9, 0), t("invoice template free", 12, 6, 0)] });
    expect(r.suggestedNegatives).toContainEqual(expect.objectContaining({ text: "free", matchType: "PHRASE", cost: 27 }));
  });

  it("does NOT block a low-intent token when a term containing it converted", () => {
    const r = analyzeWaste({ ...base, terms: [t("invoice app", 100, 20, 2), t("free trial invoice app", 30, 9, 1), t("free invoice maker", 15, 9, 0)] });
    expect(r.lowIntent.find((l) => l.token === "free")?.convertedAnyway).toBe(true);
    expect(r.suggestedNegatives.find((s) => s.text === "free")).toBeUndefined();
  });

  it("decides per campaign: a converting 'free' in one campaign doesn't protect another", () => {
    const r = analyzeWaste({ ...base, terms: [t("x", 100, 10, 2), t("free trial crm", 20, 5, 1, "10"), t("free qr code", 40, 20, 0, "20")] });
    expect(r.suggestedNegatives.filter((s) => s.text === "free").map((s) => s.campaignId)).toEqual(["20"]);
  });

  it("skips negatives the campaign already has", () => {
    const r = analyzeWaste({ ...base, existingNegatives: new Set(["10|free|PHRASE"]),
      terms: [t("invoice app", 100, 20, 2), t("free invoice maker", 15, 9, 0)] });
    expect(r.suggestedNegatives.find((s) => s.text === "free")).toBeUndefined();
  });

  it("falls back to a click floor when there are no conversions, and says tracking is suspect", () => {
    const r = analyzeWaste({ ...base, terms: [t("a", 150, 20, 0), t("b", 12, 2, 0)] });
    expect(r.totals.costPerConversion).toBeNull();
    expect(r.topWastedTerms.map((x) => x.term)).toEqual(["a"]);
    expect(r.tracking.status).toBe("warning");
    expect(r.caveats.join(" ")).toContain("provisional");
  });

  it("judges terms against their own campaign's CPA, and flags a whole campaign with none", () => {
    const campaigns = [
      { campaignId: "10", name: "Cheap product", type: "SEARCH", status: "ENABLED", cost: 100, clicks: 50, conversions: 5 },   // CPA 20
      { campaignId: "20", name: "Expensive product", type: "SEARCH", status: "ENABLED", cost: 900, clicks: 90, conversions: 3 }, // CPA 300
      { campaignId: "30", name: "Dud", type: "SEARCH", status: "ENABLED", cost: 400, clicks: 60, conversions: 0 },
      { campaignId: "40", name: "PMax", type: "PERFORMANCE_MAX", status: "ENABLED", cost: 200, clicks: 900, conversions: 2 },
    ];
    // Account CPA = 1600 / 10 = 160. "cheap waste" (25) is > its campaign's 20 but far below 160.
    const r = analyzeWaste({ ...base, campaigns, terms: [t("cheap waste", 25, 8, 0, "10"), t("pricey term", 120, 6, 0, "20")] });
    expect(r.totals.costPerConversion).toBe(160);
    expect(r.topWastedTerms.map((x) => x.term)).toEqual(["cheap waste"]);
    expect(r.campaignsToReview.map((c) => c.name)).toEqual(["Dud"]);
    expect(r.zeroConversionTerms.map((x) => x.term)).toEqual(["pricey term", "cheap waste"]);
    expect(r.caveats.join(" ")).toContain("Performance Max");
  });

  it("never suggests negatives that would gut a dead campaign or cancel a campaign's own keyword", () => {
    const campaigns = [
      { campaignId: "10", name: "Works", type: "SEARCH", status: "ENABLED", cost: 300, clicks: 100, conversions: 6 },  // CPA 50
      { campaignId: "30", name: "Drain Cleaning", type: "SEARCH", status: "ENABLED", cost: 400, clicks: 60, conversions: 0 },
    ];
    const keywords = [{ campaignId: "10", campaignName: "Works", adGroupId: "1", adGroupName: "AG", criterionId: "7",
      text: "water heater repair", matchType: "BROAD", status: "ENABLED", cost: 90, clicks: 20, conversions: 0 }];
    const r = analyzeWaste({ ...base, campaigns, keywords, terms: [
      t("drain cleaning", 120, 30, 0, "30"),            // dead campaign: the campaign is the problem
      t("water heater repair", 90, 20, 0, "10"),        // the campaign's own keyword: review it instead
      t("tankless reviews", 80, 15, 0, "10"),           // a genuinely wasted search: block it
    ] });
    const negs = r.suggestedNegatives.map((n) => `${n.campaignId}|${n.text}`);
    expect(negs).toEqual(["10|tankless reviews"]);
    expect(r.topWastedTerms.map((x) => x.term)).toContain("drain cleaning");  // still reported, just not blocked
    expect(r.campaignsToReview[0]!.reason).toContain("consider pausing it (pause_campaign)");
  });

  it("judges tracking on the whole account when scoped to one campaign", () => {
    const campaigns = [{ campaignId: "30", name: "Dud", type: "SEARCH", status: "ENABLED", cost: 400, clicks: 60, conversions: 0 }];
    const scoped = analyzeWaste({ ...base, campaigns, terms: [t("x", 400, 60, 0, "30")], accountTotals: { cost: 3000, conversions: 38 } });
    expect(scoped.tracking.status).toBe("ok");
    expect(analyzeWaste({ ...base, campaigns, terms: [t("x", 400, 60, 0, "30")] }).tracking.status).toBe("warning");
  });

  it("does not treat singular 'job' as a job seeker", () => {
    const r = analyzeWaste({ ...base, terms: [t("x", 100, 10, 2), t("job costing software", 30, 9, 0), t("plumber jobs near me", 12, 4, 0)] });
    expect(r.lowIntent.find((l) => l.token === "jobs")?.examples).toEqual(["plumber jobs near me"]);
  });

  it("flags keywords at 2x CPA with no conversions", () => {
    // Keyword spend 200 + 400 + 60 = 660 over 4 conversions → CPA 165; the bar is 2× = 330.
    const r = analyzeWaste({ ...base, terms: [t("x", 200, 10, 4)], keywords: [
      { campaignId: "10", campaignName: "Search", adGroupId: "5", adGroupName: "AG", criterionId: "6", text: "invoice app", matchType: "PHRASE",
        status: "ENABLED", cost: 200, clicks: 10, conversions: 4 },
      { campaignId: "10", campaignName: "Search", adGroupId: "5", adGroupName: "AG", criterionId: "7", text: "invoice", matchType: "BROAD",
        status: "ENABLED", cost: 400, clicks: 40, conversions: 0 },
      { campaignId: "10", campaignName: "Search", adGroupId: "5", adGroupName: "AG", criterionId: "8", text: "billing", matchType: "PHRASE",
        status: "ENABLED", cost: 60, clicks: 10, conversions: 0 },
    ] });
    expect(r.keywordsToReview.map((k) => k.criterionId)).toEqual(["7"]);
  });
});
