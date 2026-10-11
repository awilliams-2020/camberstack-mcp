import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { pageDates, pingIndexNow } from "./lastmod.js";
import { sitemapXml } from "./pages.js";

const today = new Date().toISOString().slice(0, 10);

describe("per-page lastmod", () => {
  it("dates a new page from the seed, then moves only the page whose content changed", () => {
    const db = openDb(":memory:");
    const v1 = { "/": "<style>a{}</style><h1>Home</h1>", "/privacy": "<h1>Privacy</h1>" };
    const first = pageDates(db, v1, "2026-10-01T12:00:00-04:00");
    expect(first.dates).toEqual({ "/": "2026-10-01", "/privacy": "2026-10-01" });
    expect(first.changed).toEqual(["/", "/privacy"]);             // first sighting: worth telling IndexNow

    const same = pageDates(db, v1, "2026-10-09");                 // a redeploy with no content change
    expect(same).toEqual({ dates: { "/": "2026-10-01", "/privacy": "2026-10-01" }, changed: [] });

    const css = pageDates(db, { ...v1, "/": "<style>b{}</style><h1>Home</h1>" }, "2026-10-09");
    expect(css.changed).toEqual([]);                              // styling isn't content

    const edit = pageDates(db, { ...v1, "/": "<h1>Home, rewritten</h1>" }, "2026-10-09");
    expect(edit).toEqual({ dates: { "/": today, "/privacy": "2026-10-01" }, changed: ["/"] });
  });

  it("writes each page's own date into the sitemap", () => {
    const xml = sitemapXml("https://x.test", { "/": "2026-10-10", "/privacy": "2026-10-01" });
    expect(xml).toContain("<loc>https://x.test/</loc><lastmod>2026-10-10</lastmod>");
    expect(xml).toContain("<loc>https://x.test/privacy</loc><lastmod>2026-10-01</lastmod>");
    expect(xml).toContain("<loc>https://x.test/terms</loc></url>");   // no date known: no lastmod, rather than a wrong one
  });
});

describe("IndexNow", () => {
  it("submits only the given URLs, with the key and where to verify it", async () => {
    const calls: any[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response("", { status: 202 }); }) as any;
    await pingIndexNow("https://camberstack.io", "abc123", ["/", "/tools"], f);
    expect(calls).toEqual([{ url: "https://api.indexnow.org/indexnow", body: { host: "camberstack.io", key: "abc123",
      keyLocation: "https://camberstack.io/abc123.txt", urlList: ["https://camberstack.io/", "https://camberstack.io/tools"] } }]);
    await pingIndexNow("https://camberstack.io", "abc123", [], f);
    expect(calls).toHaveLength(1);                                // nothing changed: no request
  });

  it("reports a refusal", async () => {
    const f = (async () => new Response("bad key", { status: 403 })) as any;
    await expect(pingIndexNow("https://camberstack.io", "k", ["/"], f)).rejects.toThrow("IndexNow 403");
  });
});
