import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";

const DAY = 86400;

function setup() {
  const db = openDb(":memory:");
  const sent: any[] = [];
  const lc = new Lifecycle({
    db, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7),
    mail: { apiKey: "re_test", from: "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io" },
    internalEmails: new Set(["me@example.com"]),
    upgradeLink: (u) => `https://camberstack.io/upgrade?t=${u}.sig`,
    fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as any,
  });
  const user = (id: string, email: string, ageDays: number, extra = "") =>
    db.prepare(`INSERT INTO users (id, google_sub, email, enc_refresh, created_at${extra ? ", plan" : ""}) VALUES (?, ?, ?, 'x', ?${extra ? ", ?" : ""})`)
      .run(...[id, `sub-${id}`, email, now() - ageDays * DAY, ...(extra ? [extra] : [])]);
  const call = (userId: string, tool: string) =>
    db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, ms, bytes) VALUES (?, ?, ?, 1, 10, 10)").run(now(), userId, tool);
  const applied = (userId: string, daysAgo: number, cid = "1112223333", undoOf: string | null = null) =>
    db.prepare(`INSERT INTO proposals (id, user_id, customer_id, changes, summary, status, undo_of, created_at, applied_at)
      VALUES (?, ?, ?, '[]', 's', 'applied', ?, ?, ?)`).run(`p${Math.random()}`, userId, cid, undoOf, now() - daysAgo * DAY, now() - daysAgo * DAY);
  return { db, lc, sent, user, call, applied };
}

describe("lifecycle emails", () => {
  it("sends first_steps once to someone who connected 2+ days ago and never asked anything", async () => {
    const { lc, sent, user, call } = setup();
    user("quiet", "quiet@example.com", 3);
    user("fresh", "fresh@example.com", 1);          // too soon
    user("active", "active@example.com", 3); call("active", "account_overview");
    user("listed", "listed@example.com", 3); call("listed", "list_accounts");  // listing accounts isn't using it
    user("me", "me@example.com", 3);                 // internal
    expect(await lc.run()).toBe(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["listed@example.com", "quiet@example.com"]);
    const m = sent[0];
    expect(m.subject).toBe("The first thing to ask Camberstack");
    expect(m.text).toContain("How did each of my Google Ads campaigns do last month?");
    expect(m.text).toContain("demo account");
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.reply_to).toBe("adam@camberstack.io");
    expect(await lc.run()).toBe(0);  // never twice
  });

  it("sends limit_reached once, 3+ days after the plan gate refused a second account", async () => {
    const { db, lc, sent, user, call } = setup();
    const refused = (userId: string, daysAgo: number, error = "Plan limit: Camberstack has been used on 1 Google Ads account") =>
      db.prepare("INSERT INTO tool_calls (at, user_id, tool, ok, error, ms, bytes) VALUES (?, ?, 'account_overview', 0, ?, 10, 10)")
        .run(now() - daysAgo * DAY, userId, error);
    user("capped", "capped@example.com", 10); call("capped", "propose_changes"); refused("capped", 4);
    user("recent", "recent@example.com", 10); call("recent", "propose_changes"); refused("recent", 1);  // too recent
    user("other", "other@example.com", 10); call("other", "propose_changes"); refused("other", 4, "Google said no");  // not the gate
    user("pro", "pro@example.com", 10, "pro"); call("pro", "propose_changes"); refused("pro", 4);
    expect(await lc.run()).toBe(1);
    expect(sent[0].to).toEqual(["capped@example.com"]);
    expect(sent[0].subject).toBe("Using Camberstack on more than one Google Ads account");
    expect(sent[0].text).toContain("https://camberstack.io/upgrade?t=capped.sig");
    expect(sent[0].text).toContain("up to 10 accounts");
    expect(await lc.run()).toBe(0);
  });

  it("sends check_in once, 2+ days after the first change applied to a real account", async () => {
    const { lc, sent, user, call, applied } = setup();
    const used = (id: string) => call(id, "account_overview");   // keeps first_steps out of the way
    user("acted", "acted@example.com", 5); used("acted"); applied("acted", 3); applied("acted", 1);
    user("today", "today@example.com", 5); used("today"); applied("today", 0.5);             // too soon
    user("demo", "demo@example.com", 5); used("demo"); applied("demo", 3, "0000000001");     // demo only
    user("undo", "undo@example.com", 5); used("undo"); applied("undo", 3, "1112223333", "p0"); // only an undo
    user("old", "old@example.com", 30); used("old"); applied("old", 20);                    // before this email existed
    user("pro", "pro@example.com", 5, "pro"); used("pro"); applied("pro", 3);               // Pro gets it too
    user("me", "me@example.com", 5); used("me"); applied("me", 3);                          // internal
    expect(await lc.run()).toBe(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["acted@example.com", "pro@example.com"]);
    expect(sent[0].subject).toBe("Camberstack: how did it go?");
    expect(sent[0].text).toContain("How did you find Camberstack?");
    expect(sent[0].text).not.toMatch(/first (user|customer)/i);
    expect(sent[0].reply_to).toBe("adam@camberstack.io");
    expect(await lc.run()).toBe(0);
  });

  it("unsubscribes only on POST with a valid signature, and then sends nothing", async () => {
    const { db, lc, sent, user } = setup();
    user("quiet", "quiet@example.com", 3);
    const app = express();
    lc.mount(app, (t, b) => `<h1>${t}</h1>${b}`);
    const srv = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://localhost:${(srv.address() as AddressInfo).port}`;
    const url = lc.unsubscribeUrl("quiet").replace("https://camberstack.io", base);
    try {
      expect(await (await fetch(url)).text()).toContain("Unsubscribe");               // GET only asks
      expect(db.prepare("SELECT email_opt_out o FROM users").get()).toEqual({ o: 0 });
      expect((await fetch(url.replace(/s=.{4}/, "s=XXXX"), { method: "POST" })).status).toBe(400);
      expect((await fetch(url, { method: "POST", body: "List-Unsubscribe=One-Click",
        headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(200);
      expect(db.prepare("SELECT email_opt_out o FROM users").get()).toEqual({ o: 1 });
      expect(await lc.run()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally { srv.close(); }
  });

  it("retries a failed send next run instead of marking it sent", async () => {
    const { db, user } = setup();
    let fail = true; const sent: any[] = [];
    const lc = new Lifecycle({ db, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32), internalEmails: new Set(),
      mail: { apiKey: "k", from: "f", replyTo: "r" }, upgradeLink: () => null,
      fetch: (async (_u: string, init: RequestInit) => { if (fail) return new Response("down", { status: 500 }); sent.push(init.body); return new Response("{}"); }) as any });
    user("quiet", "quiet@example.com", 3);
    const err = console.error; console.error = () => {};
    try { expect(await lc.run()).toBe(0); } finally { console.error = err; }
    fail = false;
    expect(await lc.run()).toBe(1);
  });
});
