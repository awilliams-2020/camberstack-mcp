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
