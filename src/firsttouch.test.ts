import { describe, expect, it } from "vitest";
import { touchOf } from "./firsttouch.js";

describe("touchOf", () => {
  it("keeps utm tags and Reddit's click id", () => {
    expect(touchOf({ utm_source: "Reddit", utm_campaign: "cs-reddit-2026-10", utm_content: "approve", rdt_cid: "abc_def-1234" }))
      .toEqual({ source: "reddit", campaign: "cs-reddit-2026-10", content: "approve", click: "abc_def-1234" });
  });
  it("names the source from a click id when there's no utm_source", () => {
    expect(touchOf({ rdt_cid: "abc_def-1234" })?.source).toBe("reddit");
    expect(touchOf({ gclid: "Cj0KCQtest_click_1234" })).toEqual({ source: "google-ads", campaign: null, content: null, click: null });
  });
  it("ignores untagged and malformed landings", () => {
    expect(touchOf({})).toBeNull();
    expect(touchOf({ utm_source: "<script>" })).toBeNull();
    expect(touchOf({ utm_source: "reddit", utm_campaign: "a;b", rdt_cid: "short" })).toEqual({ source: "reddit", campaign: null, content: null, click: null });
  });
});
