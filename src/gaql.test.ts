import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkGaql, closest, lookupFields, parseGaql, type Catalog, type FieldMeta } from "./gaql.js";

// A trimmed snapshot of Google's real field catalog (v23, 2026-10-14): ten resources with all their attributes,
// and a handful of metrics and segments.
const rows = JSON.parse(readFileSync(new URL("./fixtures/gaql-catalog.json", import.meta.url), "utf8")) as FieldMeta[];
const cat: Catalog = new Map(rows.map((f) => [f.name, f]));

describe("checkGaql against Google's field catalog", () => {
  // The mistakes users' assistants actually made (tool_calls.error, 2026-10).
  it("suggests the real field for a guessed path", () => {
    const [i] = checkGaql("SELECT campaign.id, campaign.maximize_clicks.cpc_bid_ceiling_micros FROM campaign", cat);
    expect(i).toContain("campaign.maximize_clicks.cpc_bid_ceiling_micros doesn't exist");
    expect(i).toContain("campaign.target_spend.cpc_bid_ceiling_micros");
  });
  it("points a sub-field of a message at the message", () => {
    const [i] = checkGaql("SELECT recommendation.type, recommendation.impact.base_metrics.clicks FROM recommendation", cat);
    expect(i).toContain("recommendation.impact.base_metrics.clicks doesn't exist");
    expect(i).toContain("recommendation.impact");
  });
  it("says where a field can be queried when this FROM can't use it", () => {
    const [i] = checkGaql("SELECT ad_group.id, campaign_budget.amount_micros FROM ad_group", cat);
    expect(i).toMatch(/campaign_budget\.amount_micros can't be used FROM ad_group; query it FROM campaign_budget or FROM campaign/);
  });
  it("catches a metric the resource doesn't have", () => {
    expect(checkGaql("SELECT ad_group.id, metrics.search_budget_lost_impression_share FROM ad_group", cat)[0])
      .toContain("metrics.search_budget_lost_impression_share can't be used FROM ad_group; query it FROM campaign");
  });
  it("finds nothing wrong with valid queries, including literals that look like fields", () => {
    for (const q of [
      "SELECT campaign.id, campaign.name, campaign_budget.amount_micros, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.clicks DESC LIMIT 10",
      "SELECT campaign.name FROM campaign WHERE campaign.name = 'a.b.c FROM x' AND campaign.status != 'REMOVED'",
      "SELECT bidding_strategy.name, bidding_strategy.target_spend.cpc_bid_ceiling_micros FROM bidding_strategy WHERE bidding_strategy.id = 1",
      "SELECT recommendation.type, recommendation.impact FROM recommendation",
      "SELECT ad_group_criterion.keyword.text, metrics.clicks FROM keyword_view WHERE segments.date DURING LAST_7_DAYS",
    ]) expect(checkGaql(q, cat), q).toEqual([]);
  });
  it("stays out of the way when it can't parse a query", () => {
    expect(parseGaql("SELECT campaign.id FROM")).toBeNull();
    expect(checkGaql("SELECT COUNT(*) FROM campaign", cat)).toEqual([]);
  });
  it("lets a segmenting resource's fields be selected (campaign FROM campaign_asset), as Google does", () => {
    expect(checkGaql("SELECT campaign.name, campaign.id, campaign_asset.field_type FROM campaign_asset", cat)).toEqual([]);
    expect(checkGaql("SELECT campaign.name, segments.geo_target_city, metrics.clicks FROM geographic_view WHERE segments.date DURING LAST_30_DAYS", cat)
      .filter((i) => !i.includes("metrics.clicks"))).toEqual([]);
  });
  it("names the values an enum takes when WHERE uses one it doesn't (2026-10-15: field_type IN ('LOCATION', 'AFFILIATE_LOCATION'))", () => {
    const issues = checkGaql("SELECT campaign.name, campaign_asset.field_type FROM campaign_asset WHERE campaign_asset.field_type IN ('LOCATION', 'AFFILIATE_LOCATION') AND campaign_asset.status = 'ENABLED'", cat);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("'LOCATION', 'AFFILIATE_LOCATION' aren't values of campaign_asset.field_type");
    expect(issues[0]).toContain("SITELINK");
    expect(issues[0]).not.toContain("UNSPECIFIED");
    expect(checkGaql("SELECT campaign.id FROM campaign WHERE campaign.status = PAUSED", cat)).toEqual([]);
    expect(checkGaql("SELECT campaign.id FROM campaign WHERE campaign.status != 'DELETED'", cat)[0]).toContain("'DELETED' isn't a value of campaign.status");
  });
  it("points a city segment FROM campaign at geographic_view", () => {
    expect(checkGaql("SELECT campaign.name, segments.geo_target_city FROM campaign", cat)[0])
      .toMatch(/segments\.geo_target_city can't be used FROM campaign; query it FROM .*geographic_view/);
  });
  it("names an unknown FROM", () => {
    expect(checkGaql("SELECT campaign.id FROM campaigns", cat)[0]).toContain("Closest: campaign");
  });
});

describe("gaql_fields lookup", () => {
  it("lists a resource's fields, joinable resources, metrics and segments, narrowed by search", () => {
    const r = lookupFields(cat, { resource: "campaign", search: "ceiling" }) as any;
    expect(r.fields.names.join(" ")).toContain("campaign.target_spend.cpc_bid_ceiling_micros");
    expect(r.also_select_from).toContain("campaign_budget");
    const a = lookupFields(cat, { resource: "campaign_asset" }) as any;
    expect(a.also_select_from).toEqual(expect.arrayContaining(["asset", "customer", "campaign", "ad_group"]));
    expect(a.segments.names.every((s: string) => s.includes("."))).toBe(true);
    expect(r.metrics.names).toEqual([]);
  });
  it("searches every resource with search alone", () => {
    const r = lookupFields(cat, { search: "cpc_bid_ceiling" }) as any;
    expect(r.matches.names.some((n: string) => n.startsWith("bidding_strategy.target_spend.cpc_bid_ceiling_micros"))).toBe(true);
  });
  it("suggests the resource it couldn't find", () => {
    expect(() => lookupFields(cat, { resource: "bid_strategy" })).toThrow("Closest:");
  });
  it("ranks the shared last part first", () => {
    expect(closest("campaign.max_clicks.cpc_bid_ceiling_micros", ["campaign.target_spend.cpc_bid_ceiling_micros", "campaign.max_clicks"])[0])
      .toBe("campaign.target_spend.cpc_bid_ceiling_micros");
  });
});
