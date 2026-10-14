import { describe, expect, it } from "vitest";
import { resolveChange } from "./changes.js";

/** A campaign that targets the United States and English only. */
const ads = {
  async search(_cid: string, q: string): Promise<any[]> {
    if (q.includes("FROM campaign_criterion")) return [
      { campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~1", type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/2840" } } },
      { campaignCriterion: { resourceName: "customers/1/campaignCriteria/10~2", type: "LANGUAGE", language: { languageConstant: "languageConstants/1000" } } },
    ];
    if (q.includes("FROM campaign")) return [{ campaign: { name: "Search", status: "ENABLED" } }];
    return [];
  },
};

describe("remove_campaign_targeting", () => {
  it("undoes only what it removed, not every id it was asked to remove", async () => {
    const r = await resolveChange(ads, "1", null, { type: "remove_campaign_targeting", campaign_id: "10",
      location_ids: ["2840", "2826"], language_ids: ["1000", "1003"] });
    expect(r.operations).toEqual([{ remove: "customers/1/campaignCriteria/10~1" }, { remove: "customers/1/campaignCriteria/10~2" }]);
    expect(r.inverse).toEqual({ type: "add_campaign_targeting", campaign_id: "10", location_ids: ["2840"], language_ids: ["1000"] });
  });

  it("has no undo when nothing it names is targeted", async () => {
    const r = await resolveChange(ads, "1", null, { type: "remove_campaign_targeting", campaign_id: "10", location_ids: ["2826"], language_ids: [] });
    expect(r.operations).toEqual([]);
    expect(r.inverse).toBeUndefined();
  });
});

describe("keyword lists", () => {
  it("skip what's already there and repeats within the request, case-insensitively", async () => {
    const ads = { async search(_c: string, q: string): Promise<any[]> {
      if (q.includes("FROM campaign_criterion")) return [{ campaignCriterion: { keyword: { text: "jobs", matchType: "PHRASE" } } }];
      return [{ campaign: { id: "10", name: "Search", advertisingChannelType: "SEARCH", status: "ENABLED" } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "add_negative_keywords", campaign_id: "10", keywords: [
      { text: "jobs", match_type: "PHRASE" }, { text: "Free", match_type: "PHRASE" }, { text: "free", match_type: "PHRASE" }, { text: "free", match_type: "EXACT" }] });
    expect(r.operations.map((o: any) => [o.create.keyword.text, o.create.keyword.matchType])).toEqual([["Free", "PHRASE"], ["free", "EXACT"]]);
    expect(r.describe).toContain("(2 already present or repeated, skipped)");
  });
});

describe("set_daily_budget", () => {
  it("writes nothing and offers no undo when the budget is already that amount", async () => {
    const ads = { async search(): Promise<any[]> {
      return [{ campaign: { name: "Search" }, campaignBudget: { resourceName: "customers/1/campaignBudgets/9", amountMicros: "40000000", explicitlyShared: false } }];
    } };
    const r = await resolveChange(ads, "1", null, { type: "set_daily_budget", campaign_id: "10", amount: 40 });
    expect(r.operations).toEqual([]);
    expect(r.inverse).toBeUndefined();
  });
});
