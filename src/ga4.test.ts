import { describe, expect, it } from "vitest";
import { AnalyticsClient, AnalyticsNotGrantedError, DEMO_PROPERTY, DemoAnalytics, landingPages, listProperties, report } from "./ga4.js";
import { toolCatalog } from "./tools.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const client = (f: (url: string, init?: RequestInit) => Response) =>
  new AnalyticsClient(async () => "t", () => "https://camberstack.io/connect/analytics?t=x", (async (u: string, i?: RequestInit) => f(String(u), i)) as typeof fetch);

describe("AnalyticsClient", () => {
  it("lists properties across pages of account summaries", async () => {
    const ga = client((u) => (u.includes("pageToken=p2")
      ? json({ accountSummaries: [{ displayName: "B", propertySummaries: [{ property: "properties/2", displayName: "Shop" }] }] })
      : json({ accountSummaries: [{ displayName: "A", propertySummaries: [{ property: "properties/1", displayName: "Site" }] }], nextPageToken: "p2" })));
    expect(await ga.properties()).toEqual([{ property_id: "1", name: "Site", account: "A" }, { property_id: "2", name: "Shop", account: "B" }]);
  });

  it("turns GA4's string metrics into numbers and sends the filter and sort", async () => {
    let sent: any;
    const ga = client((_u, i) => {
      sent = JSON.parse(String(i!.body));
      return json({ dimensionHeaders: [{ name: "landingPage" }], metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "engagementRate", type: "TYPE_FLOAT" }],
        rows: [{ dimensionValues: [{ value: "/a" }], metricValues: [{ value: "12" }, { value: "0.583333333" }] }], rowCount: 1 });
    });
    const r = await ga.runReport("9", { startDate: "2026-10-01", endDate: "2026-10-07", dimensions: ["landingPage"], metrics: ["sessions", "engagementRate"],
      filter: { dimension: "sessionDefaultChannelGroup", value: "Paid Search" }, limit: 10 });
    expect(r).toEqual({ row_count: 1, rows: [{ landingPage: "/a", sessions: 12, engagementRate: 0.5833 }] });
    expect(sent.dimensionFilter.filter).toEqual({ fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "CONTAINS", value: "Paid Search", caseSensitive: false } });
    expect(sent.orderBys).toEqual([{ metric: { metricName: "sessions" }, desc: true }]);
  });

  it("says Analytics isn't granted, with the grant link, instead of a raw 403", async () => {
    const ga = client(() => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    const out = await listProperties(ga);
    expect(out.properties[0]!.property_id).toBe(DEMO_PROPERTY);
    expect(out).toMatchObject({ grant_url: "https://camberstack.io/connect/analytics?t=x" });
    await expect(ga.runReport("9", { startDate: "a", endDate: "b", dimensions: [], metrics: ["sessions"], limit: 1 })).rejects.toBeInstanceOf(AnalyticsNotGrantedError);
  });

  it("passes other API errors through readably (e.g. the API not enabled)", async () => {
    const ga = client(() => json({ error: { code: 403, message: "Google Analytics Data API has not been used in project 123 before or it is disabled." } }, 403));
    await expect(ga.properties()).rejects.toThrow(/Google Analytics API 403: Google Analytics Data API has not been used/);
  });
});

describe("demo property", () => {
  const demo = new DemoAnalytics();

  it("shows paid traffic converting worse on the home page than on service pages", async () => {
    const r = await landingPages(demo, DEMO_PROPERTY, { days: 28, channel: "Paid Search", limit: 10 });
    expect(r.note).toContain("demo");
    const rate = (p: string) => r.landing_pages.find((x) => x.landing_page === p)!.key_event_rate!;
    expect(r.landing_pages[0]!.landing_page).toBe("/");
    expect(rate("/")).toBeLessThan(rate("/emergency-plumber"));
  });

  it("answers reports by date and channel, and names what it supports when asked for more", async () => {
    const r = await report(demo, DEMO_PROPERTY, { days: 7, start_date: "2026-10-01", end_date: "2026-10-07", dimensions: ["date"], metrics: ["sessions"], limit: 50 });
    expect(r.rows).toHaveLength(7);
    await expect(report(demo, DEMO_PROPERTY, { days: 7, dimensions: ["city"], metrics: ["sessions"], limit: 5 })).rejects.toThrow(/supports dimensions/);
    await expect(report(demo, DEMO_PROPERTY, { days: 7, dimensions: [], metrics: ["sessions"], order_by: "keyEvents", limit: 5 })).rejects.toThrow(/order_by/);
  });
});

describe("rollout", () => {
  it("lists the Google Analytics tools only when they're switched on", () => {
    const names = (on: boolean) => toolCatalog(on).map((t) => t.name).filter((n) => n.startsWith("analytics_"));
    expect(names(true)).toEqual(["analytics_properties", "analytics_landing_pages", "analytics_report"]);
    expect(names(false)).toEqual([]);
  });
});
