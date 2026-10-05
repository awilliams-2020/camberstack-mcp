/**
 * End to end over real HTTP against a fake Google: register an MCP client, authorize with PKCE,
 * bounce through "Google", get tokens, then drive the tools through MCP, including the
 * propose → apply → undo cycle and the guards around apply.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./server.js";
import { openDb } from "./db.js";
import type { Config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { createRelayKey } from "./relay.js";

const key = randomBytes(32);
const idToken = (sub: string, email: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, email, email_verified: true })).toString("base64url")}.s`;

/** Who "Google" signs in as; a test can switch it to connect a second, brand-new user. */
const googleUser = { sub: "google-sub-1", email: "Owner@Example.com" };

/** Google's token endpoint. */
const googleFetch: typeof fetch = async (url) => {
  if (String(url).includes("oauth2.googleapis.com/token")) {
    return new Response(JSON.stringify({
      access_token: "g-access", expires_in: 3600, refresh_token: "g-refresh",
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords",
      id_token: idToken(googleUser.sub, googleUser.email),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

/** A tiny in-memory Google Ads account. */
class FakeAds {
  mutations: { service: string; operations: any[]; validateOnly: boolean }[] = [];
  negatives: { text: string; matchType: string; rn: string }[] = [];
  kwStatus = "ENABLED";
  campaignStatus = "ENABLED";
  campaignEnd: string | undefined;
  async listAccessibleCustomers() { return ["1112223333"]; }
  async search(_cid: string, q: string): Promise<any[]> {
    if (q.includes("FROM customer_client")) {
      return [{ customerClient: { id: "1112223333", descriptiveName: "Acme", currencyCode: "USD", manager: false, level: 0 } }];
    }
    if (q.includes("FROM campaign_criterion")) {
      return this.negatives.map((n) => ({ campaign: { id: "10" }, campaignCriterion: { keyword: { text: n.text, matchType: n.matchType } } }));
    }
    if (q.includes("FROM ad_group_criterion")) {
      return [{ adGroupCriterion: { status: this.kwStatus, cpcBidMicros: this.kwBid, keyword: { text: "invoice", matchType: "BROAD" } }, adGroup: { name: "AG", cpcBidMicros: this.agBid }, campaign: { name: "Search" } }];
    }
    if (q.includes("FROM campaign_conversion_goal")) {
      return Object.entries(this.goals).map(([cat, biddable]) => ({ campaign: { name: "Search" }, campaignConversionGoal: {
        resourceName: `customers/1112223333/campaignConversionGoals/10~${cat}~WEBSITE`, category: cat, origin: "WEBSITE", biddable } }));
    }
    if (q.includes("FROM ad_group WHERE")) return [{ adGroup: { name: "AG", cpcBidMicros: this.agBid }, campaign: { name: "Search", status: this.campaignStatus } }];
    if (q.includes("FROM ad_group_ad")) return [{ adGroupAd: { status: "ENABLED", ad: { finalUrls: ["https://example.com/old"] } }, adGroup: { name: "AG" }, campaign: { name: "Search" } }];
    if (q.includes("FROM conversion_action WHERE conversion_action.name")) return [];
    if (q.includes("FROM conversion_action WHERE conversion_action.id")) return [{ conversionAction: { name: "Signup", countingType: "MANY_PER_CLICK" } }];
    if (q.includes("campaign.name = ")) return q.includes("campaign.name = 'Search'") ? [{ campaign: { id: "10" } }] : [];
    if (q.includes("FROM campaign")) {
      return [{ campaign: { id: "10", name: "Search", status: this.campaignStatus, endDateTime: this.campaignEnd, advertisingChannelType: "SEARCH",
          biddingStrategyType: "MANUAL_CPC", manualCpc: { enhancedCpcEnabled: false }, finalUrlSuffix: "" },
        campaignBudget: { resourceName: "customers/1112223333/campaignBudgets/99", amountMicros: "20000000", explicitlyShared: false },
        metrics: { costMicros: "200000000", clicks: "80", impressions: "900", conversions: 4, conversionsValue: 400 } }];
    }
    if (q.includes("FROM search_term_view")) {
      return [
        { searchTermView: { searchTerm: "invoice app" }, campaign: { id: "10", name: "Search" }, metrics: { costMicros: "120000000", clicks: "30", conversions: 4 } },
        { searchTermView: { searchTerm: "free invoice maker" }, campaign: { id: "10", name: "Search" }, metrics: { costMicros: "60000000", clicks: "25", conversions: 0 } },
      ];
    }
    if (q.includes("FROM keyword_view")) return [];
    if (q.includes("FROM conversion_action")) {
      return [{ conversionAction: { id: "1", name: "Purchase", category: "PURCHASE", status: "ENABLED", primaryForGoal: true, type: "WEBPAGE" } }];
    }
    return [];
  }
  plannerCalls: { method: string; req: any }[] = [];
  async keywordPlan(_cid: string, method: string, req: any) {
    this.plannerCalls.push({ method, req });
    if (method === "generateKeywordIdeas") {
      return { results: [
        { text: "invoice", keywordIdeaMetrics: { avgMonthlySearches: "90500", competition: "HIGH", lowTopOfPageBidMicros: "2100000", highTopOfPageBidMicros: "9800000" } },
        { text: "invoice software", keywordIdeaMetrics: { avgMonthlySearches: "12100", competition: "HIGH", lowTopOfPageBidMicros: "8000000", highTopOfPageBidMicros: "31000000" } },
        { text: "free invoice maker", keywordIdeaMetrics: { avgMonthlySearches: "40", competition: "LOW" } },
        { text: "invoice template docx" },
      ] };
    }
    return { results: [{ text: "invoice software", closeVariants: ["invoicing software"], keywordMetrics: {
      avgMonthlySearches: "12100", competition: "HIGH",
      monthlySearchVolumes: [{ year: "2026", month: "AUGUST", monthlySearches: "11000" }, { year: "2026", month: "SEPTEMBER", monthlySearches: "13000" }],
    } }] };
  }
  goals: Record<string, boolean> = { PURCHASE: true, SIGNUP: true };
  uploads: { cid: string; conversions: any[] }[] = [];
  agBid = "1000000";
  kwBid: string | undefined;
  async uploadClickConversions(cid: string, conversions: any[]) {
    this.uploads.push({ cid, conversions });
    return conversions.map((c) => (c.gclid === "STALE_CLICK_ID_0001" ? "The click is too old" : null));
  }
  removed: string[] = [];
  async mutate(_cid: string, service: string, operations: any[], opts: { validateOnly?: boolean } = {}) {
    this.mutations.push({ service, operations, validateOnly: !!opts.validateOnly });
    if (opts.validateOnly) return { results: [] };
    if (service === "googleAds") {
      return { results: operations.map((op, i) => {
        const key = Object.keys(op)[0]!, inner = op[key];
        if (inner.remove) { this.removed.push(inner.remove); return { resourceName: inner.remove }; }
        const coll = key.replace(/Operation$/, "").replace(/Criterion$/, "Criteria").replace(/^(?!.*Criteria$)(.*)$/, "$1s");
        return { resourceName: `customers/1112223333/${coll}/${500 + i}` };
      }) };
    }
    if (service === "campaignConversionGoals") {
      for (const op of operations) this.goals[op.update.resourceName.split("~")[1]] = op.update.biddable;
      return { results: operations.map((op) => ({ resourceName: op.update.resourceName })) };
    }
    if (operations[0]?.remove && service !== "campaignCriteria") {
      this.removed.push(...operations.map((op) => op.remove));
      return { results: operations.map((op) => ({ resourceName: op.remove })) };
    }
    if (service === "adGroupCriteria" && operations[0]?.create) {
      return { results: operations.map((_op, i) => ({ resourceName: `customers/1112223333/adGroupCriteria/20~${700 + i}` })) };
    }
    return {
      results: operations.map((op, i) => {
        if (op.create?.negative) {
          const rn = `customers/1112223333/campaignCriteria/10~${900 + this.negatives.length + i}`;
          this.negatives.push({ text: op.create.keyword.text, matchType: op.create.keyword.matchType, rn });
          return { resourceName: rn };
        }
        if (op.remove) { this.negatives = this.negatives.filter((n) => n.rn !== op.remove); return { resourceName: op.remove }; }
        if (op.updateMask === "cpc_bid_micros") {
          if (service === "adGroups") this.agBid = op.update.cpcBidMicros; else this.kwBid = op.update.cpcBidMicros;
          return { resourceName: op.update.resourceName };
        }
        if (op.update?.endDateTime) { this.campaignEnd = op.update.endDateTime; return { resourceName: op.update.resourceName }; }
        if (op.update?.status && service === "campaigns") { this.campaignStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        if (op.update?.status) { this.kwStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        return { resourceName: op.update?.resourceName };
      }),
    };
  }
}

/** Stripe, just enough of it: Checkout, session lookup, the sweep's list, subscriptions, the portal. */
const stripe = { subStatus: "active", checkouts: [] as URLSearchParams[], portalReturn: "" };
const stripeFetch: typeof fetch = async (url, init) => {
  const u = String(url).replace("https://api.stripe.com/v1/", "");
  const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u === "checkout/sessions" && init?.method === "POST") {
    stripe.checkouts.push(init.body as URLSearchParams);
    return j({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  }
  if (u === "checkout/sessions/cs_test_1") {
    const f = stripe.checkouts.at(-1)!;
    return j({ id: "cs_test_1", status: "complete", metadata: { app: f.get("metadata[app]") },
      client_reference_id: f.get("client_reference_id"), customer: "cus_1", subscription: "sub_1" });
  }
  if (u.startsWith("checkout/sessions?")) {
    const f = stripe.checkouts.at(-1);
    return j({ data: f ? [{ id: "cs_test_1", status: "complete", metadata: { app: f.get("metadata[app]") },
      client_reference_id: f.get("client_reference_id"), customer: "cus_1", subscription: "sub_1" }] : [] });
  }
  if (u === "subscriptions/sub_1") return j({ id: "sub_1", status: stripe.subStatus });
  if (u.startsWith("billing_portal/configurations")) return j({ data: [{ id: "bpc_1", is_default: false, active: true }] });
  if (u === "billing_portal/sessions") {
    expect((init?.body as URLSearchParams).get("configuration")).toBe("bpc_1");
    stripe.portalReturn = (init?.body as URLSearchParams).get("return_url") ?? "";
    return j({ url: "https://billing.stripe.com/p/session_1" });
  }
  throw new Error(`unexpected stripe ${u}`);
};

/** Our own Ads account's conversion upload endpoint, plus the operator's token refresh. */
const conversionUploads: any[] = [];
const adsConversionFetch: typeof fetch = async (url, init) => {
  if (String(url).includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "op-token", expires_in: 3600 }), { status: 200 });
  if (String(url).includes(":uploadClickConversions")) { conversionUploads.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }
  throw new Error(`unexpected ${url}`);
};

let app: ReturnType<typeof createApp>["app"];
let billing: ReturnType<typeof createApp>["billing"];
let relay: ReturnType<typeof createApp>["relay"];
let server: Server;
let base = "";
const ads = new FakeAds();
const db = openDb(":memory:");

beforeAll(async () => {
  const cfg: Config = {
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: key,
    google: { clientId: "gid", clientSecret: "gsecret" },
    freeAccounts: 1, proAccounts: 10, stripe: { secretKey: "sk_test_x", proPriceId: "price_pro" }, proEmails: new Set(), adminEmails: new Set(["owner@example.com"]), gitSha: "test", gitCommitDate: "",
  };
  // Bind first so baseUrl (the OAuth issuer) is the real test origin.
  server = await new Promise<Server>((resolve) => { const s = createApp(cfg, db).app.listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.close();
  server = await new Promise<Server>((resolve) => {
    ({ app, billing, relay } = createApp({ ...cfg, baseUrl: base, adminUrl: base.replace("localhost", "127.0.0.1"),
      conversions: { customerId: "9998887777", actionId: "555", clientId: "c", clientSecret: "s", refreshToken: "r", developerToken: "d" } }, db, { fetch: googleFetch, stripeFetch, adsConversionFetch, adsFactory: () => ads as any }));
    const s = app.listen(Number(new URL(base).port), () => resolve(s));
  });
});
afterAll(() => { server?.close(); });

async function connect(cookie?: string, state = "xyz"): Promise<string> {
  const redirect = "http://localhost:9999/callback";
  const reg = await fetch(`${base}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test AI", token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(reg.status).toBe(201);
  const client = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(`${base}/authorize`);
  auth.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state, scope: "ads" }).toString();
  const toGoogle = await fetch(auth, { redirect: "manual" });
  expect(toGoogle.status).toBe(302);
  const g = new URL(toGoogle.headers.get("location")!);
  expect(g.host).toBe("accounts.google.com");
  expect(g.searchParams.get("scope")).toContain("adwords");

  const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`,
    { redirect: "manual", ...(cookie ? { headers: { cookie } } : {}) });
  expect(back.status).toBe(302);
  lastCallbackCookies = back.headers.get("set-cookie") ?? "";
  const cb = new URL(back.headers.get("location")!);
  expect(cb.searchParams.get("state")).toBe(state);

  const tok = await fetch(`${base}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, code_verifier: verifier,
      client_id: client.client_id, redirect_uri: redirect }),
  });
  expect(tok.status).toBe(200);
  return (await tok.json()).access_token;
}

/** Google → our shared callback → the page's own callback, which sets its session cookie. */
async function signIn(google: URL): Promise<string> {
  const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${google.searchParams.get("state")}`, { redirect: "manual" });
  expect(back.status).toBe(302);
  const hop = await fetch(new URL(back.headers.get("location")!, base), { redirect: "manual" });
  expect(hop.status).toBe(302);
  expect(hop.headers.get("set-cookie")).toContain("HttpOnly");
  return hop.headers.get("set-cookie")!.split(";")[0]!;
}

let lastCallbackCookies = "";
let rpcId = 0;
async function call(token: string, name: string, args: object = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  return { isError: !!body.result?.isError, text, json: body.result?.isError ? null : JSON.parse(text || "null") };
}

describe("OAuth + MCP end to end", () => {
  let token = "";

  it("rejects /mcp without a token and points at the resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("connects through Google and stores the Google refresh token encrypted", async () => {
    token = await connect();
    const u = db.prepare("SELECT * FROM users").get() as any;
    expect(u.email).toBe("owner@example.com");
    expect(u.enc_refresh).not.toContain("g-refresh");
    expect(decrypt(key, u.enc_refresh)).toBe("g-refresh");
    const raw = db.prepare("SELECT token_hash FROM tokens").all() as any[];
    expect(raw.some((r) => r.token_hash === token)).toBe(false); // hashed, never stored raw
  });

  it("lists tools", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (await res.json()).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["list_accounts", "account_overview", "keyword_ideas", "keyword_metrics", "propose_changes", "apply_changes", "undo_changes"]));
    // The AI sees what each change field means, and never the undo-only change type.
    const propose = JSON.stringify(tools.find((t: any) => t.name === "propose_changes").inputSchema);
    expect(propose).toContain("not micros");
    expect(propose).toContain("campaign_id from account_overview");
    expect(propose).not.toContain("remove_negative_keywords");
    // Directory listings read the human-readable name from annotations.title, and need the safety hints.
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBe(t.title);
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      if (!t.annotations.readOnlyHint) expect(typeof t.annotations.destructiveHint, t.name).toBe("boolean");
    }
  });

  it("reads an account overview", async () => {
    const r = await call(token, "account_overview", { customer_id: "111-222-3333", days: 30 });
    expect(r.isError).toBe(false);
    expect(r.json.campaigns.length).toBeGreaterThan(0);
  });

  it("proposes without writing, applies, and undoes", async () => {
    const p = await call(token, "propose_changes", { customer_id: "1112223333", changes: [
      { type: "add_negative_keywords", campaign_id: "10", keywords: [{ text: "free", match_type: "PHRASE" }] },
      { type: "pause_keyword", ad_group_id: "5", criterion_id: "7" },
    ] });
    expect(p.isError).toBe(false);
    expect(p.json.summary).toContain('"free"');
    expect(ads.mutations.every((m) => m.validateOnly)).toBe(true);
    expect(ads.negatives).toHaveLength(0);

    const a = await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
    expect(a.json.status).toBe("applied");
    expect(ads.negatives.map((n) => n.text)).toEqual(["free"]);
    expect(ads.kwStatus).toBe("PAUSED");

    const again = await call(token, "apply_changes", { proposal_id: p.json.proposal_id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already applied");

    const u = await call(token, "undo_changes", { proposal_id: p.json.proposal_id });
    expect(u.json.summary).toContain("Enable keyword");
    expect(u.json.summary).toContain('Remove 1 negative keyword(s) previously added to campaign "Search"');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.negatives).toHaveLength(0);
    expect(ads.kwStatus).toBe("ENABLED");

    const h = await call(token, "change_history", {});
    expect(h.json.map((x: any) => x.status)).toEqual(["applied", "applied"]);
  });

  it("covers 1 account on Free with unlimited changes, asks to upgrade on a second; undo is never gated", async () => {
    const negative = async (text: string) => {
      const p = await call(token, "propose_changes", { customer_id: "1112223333",
        changes: [{ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text, match_type: "PHRASE" }] }] });
      return p.json.proposal_id as string;
    };
    // The account already in use takes any number of changes.
    for (const t of ["jobs", "login", "how to"]) expect((await call(token, "apply_changes", { proposal_id: await negative(t) })).json.status).toBe("applied");
    const third = (await call(token, "change_history", {})).json[0].proposal_id as string;

    // A second account is refused before any Google call, with a personal upgrade link.
    const blocked = await call(token, "account_overview", { customer_id: "999-888-7777", days: 30 });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("Plan limit:");
    expect(blocked.text).toContain("1 Google Ads account in the last 30 days (1112223333)");
    const link = blocked.text.match(/https?:\/\/\S+\/upgrade\?t=[\w.-]+/)![0];
    // A refused call doesn't count as use, and the demo never counts.
    expect((await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).isError).toBe(false);

    // Undo still works.
    const u = await call(token, "undo_changes", { proposal_id: third });
    expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");

    const plan = await call(token, "billing", {});
    expect(plan.json).toMatchObject({ plan: "free", accounts_in_use: ["1112223333"], accounts_included: 1, window_days: 30 });
    expect(plan.json.upgrade_url).toContain("/upgrade?t=");

    // A tampered link is refused; the real one goes to Stripe Checkout as a subscription for this user.
    expect((await fetch(link.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { redirect: "manual" })).status).toBe(400);
    const go = await fetch(link, { redirect: "manual" });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toContain("checkout.stripe.com");
    const form = stripe.checkouts.at(-1)!;
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer_email")).toBe("owner@example.com");

    // Paid, but closed the tab before /upgraded: the gate asks Stripe first, so the very next call gets through.
    expect(db.prepare("SELECT plan FROM users WHERE email = 'owner@example.com'").get()).toEqual({ plan: "free" });
    const paidNoTab = await call(token, "account_overview", { customer_id: "999-888-7777", days: 30 });
    expect(paidNoTab.text).not.toContain("Plan limit:");  // past the gate; this login just can't read that account
    expect(db.prepare("SELECT plan FROM users WHERE email = 'owner@example.com'").get()).toEqual({ plan: "pro" });

    // /upgraded is still fine afterwards (settling is idempotent).
    const done = await fetch(`${base}/upgraded?session_id=cs_test_1`);
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toContain("on Camberstack Pro");
    expect(doneHtml).toContain('href="/account"');
    expect(doneHtml).toContain("up to 10 Google Ads accounts");

    const pro = await call(token, "billing", {});
    expect(pro.json.plan).toBe("pro");
    const portal = await fetch(pro.json.manage_billing, { redirect: "manual" });
    expect(portal.headers.get("location")).toContain("billing.stripe.com");
    expect(stripe.portalReturn).toBe(`${base}/account`);

    // Cancelled at period end: the hourly sweep drops the plan back to free.
    stripe.subStatus = "canceled";
    await billing.sweep();
    expect((await call(token, "billing", {})).json.plan).toBe("free");
    // A completed checkout for a cancelled subscription never makes anyone Pro again, sweep after sweep.
    db.prepare("UPDATE users SET stripe_sub = NULL").run();
    await billing.sweep();
    expect((await call(token, "billing", {})).json.plan).toBe("free");
    // Not re-linked at all (the old sweep re-linked, then downgraded in the same pass: right result, wrong path).
    expect(db.prepare("SELECT count(*) n FROM users WHERE stripe_sub IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("refuses to apply a proposal that doesn't exist or isn't the user's", async () => {
    const r = await call(token, "apply_changes", { proposal_id: "p_nope" });
    expect(r.isError).toBe(true);
  });

  it("surfaces Google's refusal instead of reporting no accounts", async () => {
    const realSearch = ads.search.bind(ads);
    ads.search = async (cid: string, q: string) => {
      if (q.includes("FROM customer_client")) throw new Error("Google Ads API 403: ACTION_NOT_PERMITTED The Google Cloud project is only approved for use with test accounts.");
      return realSearch(cid, q);
    };
    // A fresh token means a fresh session, so the accounts cache from earlier tests doesn't apply.
    const fresh = await connect();
    const r = await call(fresh, "list_accounts");
    ads.search = realSearch;
    // Not a dead end: the demo account is offered, and Google's reason is still reported.
    expect(r.isError).toBe(false);
    expect(r.json.accounts.map((x: any) => x.customerId)).toEqual(["0000000001"]);
    expect(r.json.unreadable[0].error).toContain("ACTION_NOT_PERMITTED");
    expect(r.json.note).toContain("demo");
  });

  it("gets Keyword Planner ideas and metrics without changing anything", async () => {
    const before = ads.mutations.length;
    const i = await call(token, "keyword_ideas", { customer_id: "111-222-3333", keywords: ["invoice"], url: "https://acme.test/", min_searches: 100 });
    expect(i.isError).toBe(false);
    const sent = ads.plannerCalls.at(-1)!;
    expect(sent.method).toBe("generateKeywordIdeas");
    expect(sent.req).toMatchObject({ language: "languageConstants/1000", geoTargetConstants: ["geoTargetConstants/2840"],
      keywordAndUrlSeed: { keywords: ["invoice"], url: "https://acme.test/" } });
    // Biggest first; below min_searches and no-data ideas dropped; bids in currency units, not micros.
    expect(i.json.ideas.map((x: any) => x.keyword)).toEqual(["invoice", "invoice software"]);
    expect(i.json.ideas[1].top_of_page_bid).toEqual({ low: 8, high: 31 });
    expect(i.json.ideas[0].in_account).toBe("keyword");
    expect(i.json.ideas[1].in_account).toBeUndefined();

    const m = await call(token, "keyword_metrics", { customer_id: "1112223333", keywords: ["Invoicing Software", "zzz"], location_ids: ["2826"] });
    expect(ads.plannerCalls.at(-1)!.req.geoTargetConstants).toEqual(["geoTargetConstants/2826"]);
    expect(m.json.keywords[0]).toMatchObject({ keyword: "invoice software", avg_monthly_searches: 12100, monthly: { "2026-08": 11000, "2026-09": 13000 } });
    expect(m.json.no_data).toEqual(["zzz"]);

    expect((await call(token, "keyword_ideas", { customer_id: "1112223333" })).isError).toBe(true);  // needs a seed
    expect(ads.mutations.length).toBe(before);
  });

  it("runs the whole flow on the demo account without touching Google or the free allowance", async () => {
    const before = ads.mutations.length;
    const left = (await call(token, "billing", {})).json;
    const w = (await call(token, "account_overview", { customer_id: "000-000-0001", days: 180 })).json;
    expect(w.note).toContain("Sample data");
    expect(w.campaigns.map((c: any) => c.name)).toContain("Drain Cleaning – Search");

    const q = (await call(token, "run_gaql", { customer_id: "0000000001",
      query: "SELECT ad_group_criterion.keyword.text, metrics.cost_micros FROM keyword_view WHERE campaign.id = 2003 AND segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 2" })).json;
    expect(q.rows).toHaveLength(2);
    expect(q.rows[0].adGroupCriterion.keyword.text).toBe("drain cleaning");

    const p = (await call(token, "propose_changes", { customer_id: "0000000001", changes: [
      { type: "pause_campaign", campaign_id: "2003" },
      { type: "add_negative_keywords", campaign_id: "2001", keywords: [{ text: "jobs", match_type: "PHRASE" }] },
      { type: "set_daily_budget", campaign_id: "2001", amount: 50 },
      { type: "set_end_date", campaign_id: "2001", end_date: "2030-01-31" },
    ] })).json;
    expect(p.summary).toContain('Pause campaign "Drain Cleaning – Search"');
    expect(p.summary).toContain('Set end date of campaign "Emergency Plumbing – Search" from no end date to 2030-01-31');
    const a = (await call(token, "apply_changes", { proposal_id: p.proposal_id })).json;
    expect(a.status).toBe("applied");
    const after = (await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).json;
    expect(after.campaigns.find((c: any) => c.campaign_id === "2003").status).toBe("PAUSED");
    expect(after.campaigns.find((c: any) => c.campaign_id === "2001").daily_budget).toBe(50);

    const u = (await call(token, "undo_changes", { proposal_id: p.proposal_id })).json;
    await call(token, "apply_changes", { proposal_id: u.proposal_id });
    const reverted = (await call(token, "account_overview", { customer_id: "0000000001", days: 30 })).json;
    expect(reverted.campaigns.find((c: any) => c.campaign_id === "2003").status).toBe("ENABLED");
    expect(reverted.campaigns.find((c: any) => c.campaign_id === "2001").daily_budget).toBe(40);
    const endQ = `SELECT campaign.end_date_time FROM campaign WHERE campaign.id = 2001`;
    const end = (await call(token, "run_gaql", { customer_id: "0000000001", query: endQ })).json;
    expect(end.rows[0].campaign.endDateTime).toBe("2037-12-30 23:59:59");  // undo removed it

    // Building is simulated on the demo: it proposes, applies and undoes without touching Google.
    const ad = { headlines: ["Sewer Line Repair", "Same-Day Service", "Licensed Plumbers"], descriptions: ["Call now.", "Upfront prices."], final_url: "https://example.com/sewer" };
    const b = await call(token, "propose_changes", { customer_id: "0000000001", changes: [{ type: "create_campaign", name: "Sewer – Search", daily_budget: 15,
      ad_groups: [{ name: "Sewer", default_max_cpc: 6, keywords: [{ text: "sewer line repair", match_type: "PHRASE" }], ads: [ad] }] },
      { type: "add_keywords", ad_group_id: "3005", keywords: [{ text: "drain unclogging", match_type: "PHRASE" }] }] });
    if (b.isError) throw new Error(b.text);
    expect(b.json.summary).toContain('Create Search campaign "Sewer – Search", PAUSED');
    expect((await call(token, "apply_changes", { proposal_id: b.json.proposal_id })).json.status).toBe("applied");
    const bu = (await call(token, "undo_changes", { proposal_id: b.json.proposal_id })).json;
    expect(bu.summary).toContain('Remove campaign "Sewer – Search"');
    expect((await call(token, "apply_changes", { proposal_id: bu.proposal_id })).json.status).toBe("applied");

    const ideas = (await call(token, "keyword_ideas", { customer_id: "0000000001", keywords: ["water heater"] })).json;
    expect(ideas.note).toContain("Sample data");
    expect(ideas.ideas[0].keyword).toBe("tankless water heater");
    expect(ideas.ideas.find((x: any) => x.keyword === "water heater repair").in_account).toBe("keyword");
    const kws = (await call(token, "keyword_metrics", { customer_id: "0000000001", keywords: ["sewer line repair"] })).json;
    expect(Object.keys(kws.keywords[0].monthly)).toHaveLength(12);

    expect(ads.mutations.length).toBe(before);  // Google was never called
    const now = (await call(token, "billing", {})).json;  // allowance untouched (the signed link's expiry may tick)
    expect({ plan: now.plan, used: now.accounts_in_use }).toEqual({ plan: left.plan, used: left.accounts_in_use });
  });

  it("logs each tool call by name, without arguments or results", async () => {
    const rows = db.prepare("SELECT * FROM tool_calls ORDER BY id").all() as any[];
    const tools = rows.map((r) => r.tool);
    expect(tools).toContain("account_overview");
    expect(tools).toContain("apply_changes");
    const overview = rows.find((r) => r.tool === "account_overview" && r.customer_id === "1112223333");
    expect(overview).toMatchObject({ ok: 1, error: null, customer_id: "1112223333" });
    expect(overview.client_id).toBeTruthy();
    expect(overview.bytes).toBeGreaterThan(0);
    const failed = rows.find((r) => r.ok === 0);
    expect(failed?.error).toBeTruthy();
    expect(failed?.error).not.toMatch(/^Error: /);
    expect(JSON.stringify(rows)).not.toContain("free invoice maker");
  });

  it("serves the admin site only on its own host, behind a Google sign-in for ADMIN_EMAILS", async () => {
    const admin = base.replace("localhost", "127.0.0.1");
    // The main site has no /admin at all.
    expect((await fetch(`${base}/admin`, { redirect: "manual" })).status).toBe(404);
    const gate = await fetch(`${admin}/`, { redirect: "manual" });
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe("/login");
    const login = await fetch(`${admin}/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    // Google returns to the main site's registered callback, which forwards to the admin host.
    expect(g.searchParams.get("redirect_uri")).toBe(`${base}/oauth/google/callback`);
    const cookie = await signIn(g);
    expect(cookie).toMatch(/^cs_admin=/);
    const page = await fetch(`${admin}/?days=30&internal=1`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("account_overview");
    expect(html).toContain("owner@example.com");
    // The operator's own account is internal: hidden unless asked for.
    const json = await (await fetch(`${admin}/?format=json`, { headers: { cookie } })).json();
    expect(json.funnel.all.connected).toBe(0);
    // The admin host serves nothing else from the public site.
    expect((await fetch(`${admin}/privacy`)).status).toBe(404);
    expect((await fetch(`${admin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    // A replayed state is refused; a forged cookie gets the sign-in redirect.
    expect((await fetch(`${admin}/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(`${admin}/`, { headers: { cookie: "cs_admin=forged" }, redirect: "manual" })).status).toBe(302);
  });

  it("shows a connected user their plan and changes at /account, and disconnects from there", async () => {
    expect(await (await fetch(`${base}/account`)).text()).toContain("Sign in with Google");
    // The pricing CTA's sign-in link carries the upgrade intent; a plain visit's doesn't, and no cookie lingers.
    const intent = await fetch(`${base}/account?upgrade=1`);
    expect(await intent.text()).toContain('href="/account/login?next=upgrade"');
    expect(intent.headers.get("set-cookie")).toBeNull();
    const login = await fetch(`${base}/account/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    const cookie = await signIn(g);
    expect(cookie).toMatch(/^cs_account=/);
    // A sign-in started from the upgrade screen comes back to /account?upgrade=1; an ordinary one to /account.
    const viaUpgrade = new URL((await fetch(`${base}/account/login?next=upgrade`, { redirect: "manual" })).headers.get("location")!);
    const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${viaUpgrade.searchParams.get("state")}`, { redirect: "manual" });
    const hop = await fetch(new URL(back.headers.get("location")!, base), { redirect: "manual" });
    expect(hop.headers.get("location")).toBe("/account?upgrade=1");
    expect((await fetch(`${base}/account`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
    const html = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
    expect(html).toContain("owner@example.com");
    expect(html).toContain('class="pill undone"');
    expect(html).toContain("data-copy=\"Undo Camberstack proposal ");
    expect(html).toContain('Add 1 negative keyword');
    // An applied undo folds into the change it reversed instead of being its own entry.
    expect(html).not.toContain('Remove 1 negative keyword');
    // Disconnect needs the explicit confirmation.
    const noConfirm = await fetch(`${base}/account/disconnect`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(noConfirm.status).toBe(303);
    expect(db.prepare("SELECT enc_refresh FROM users").get()).not.toMatchObject({ enc_refresh: null });
    // (Disconnecting for real would end the shared test user's connection; covered by the tool's own path.)
    expect((await fetch(`${base}/account`, { headers: { cookie: "cs_account=forged" } })).status).toBe(200);
    expect(await (await fetch(`${base}/account`, { headers: { cookie: "cs_account=forged" } })).text()).toContain("Sign in with Google");
  });

  it("pauses and re-enables a campaign, warning before it spends again; flags big budget increases", async () => {
    db.prepare("UPDATE users SET plan = 'pro'").run();  // the free applies were used up above
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };

    const pause = await propose([{ type: "pause_campaign", campaign_id: "10" }]);
    expect(pause.summary).toContain('Pause campaign "Search" (now ENABLED)');
    expect(pause.summary).not.toContain("⚠");
    await call(token, "apply_changes", { proposal_id: pause.proposal_id });
    expect(ads.campaignStatus).toBe("PAUSED");

    // Pausing again is already in place: refused, nothing stored.
    await expect(propose([{ type: "pause_campaign", campaign_id: "10" }])).rejects.toThrow("already in place");

    const enable = await propose([{ type: "enable_campaign", campaign_id: "10" }]);
    expect(enable.summary).toContain("⚠ it starts spending again, up to an average of 20.00/day");
    await call(token, "apply_changes", { proposal_id: enable.proposal_id });
    expect(ads.campaignStatus).toBe("ENABLED");

    // Undo of the pause re-enables; undo of the enable pauses.
    const u = await call(token, "undo_changes", { proposal_id: enable.proposal_id });
    expect(u.json.summary).toContain('Pause campaign "Search"');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.campaignStatus).toBe("PAUSED");

    const big = await propose([{ type: "set_daily_budget", campaign_id: "10", amount: 100 }]);
    expect(big.summary).toContain("from 20.00 to 100.00 ⚠ 5.0× the current budget");
    const small = await propose([{ type: "set_daily_budget", campaign_id: "10", amount: 30 }]);
    expect(small.summary).not.toContain("⚠");
  });

  it("warns with the budget and end date a proposal sets, not the ones it replaces; end dates undo", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    expect(ads.campaignStatus).toBe("PAUSED");

    // Budget $20 live; the proposal lowers it to $10 and caps the run, then enables.
    const test = await propose([
      { type: "set_daily_budget", campaign_id: "10", amount: 10 },
      { type: "set_end_date", campaign_id: "10", end_date: "2030-01-31" },
      { type: "enable_campaign", campaign_id: "10" },
    ]);
    expect(test.summary).toContain('Set end date of campaign "Search" from no end date to 2030-01-31 (it stops serving after that day)');
    expect(test.summary).toContain("⚠ it starts spending again, up to an average of 10.00/day until 2030-01-31");
    expect(test.summary).not.toContain("20.00/day");
    const applied = await call(token, "apply_changes", { proposal_id: test.proposal_id });
    expect(applied.json.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(ads.campaignEnd).toBe("2030-01-31 23:59:59");
    expect(ads.campaignStatus).toBe("ENABLED");

    // Setting the same date again is already in place.
    await expect(propose([{ type: "set_end_date", campaign_id: "10", end_date: "2030-01-31" }])).rejects.toThrow("already in place");

    // Undo pauses, restores the budget and removes the end date (Google's 2037-12-30 stand-in).
    const u = await call(token, "undo_changes", { proposal_id: test.proposal_id });
    expect(u.json.summary).toContain("from 2030-01-31 to no end date");
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.campaignEnd).toBe("2037-12-30 23:59:59");
    expect(ads.campaignStatus).toBe("PAUSED");
  });

  it("builds a paused campaign atomically, adds keywords, scopes its conversion goal, and undoes each", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const ad = { headlines: ["Cleaning Invoice Template", "Send It With a Pay Button", "Start Free"], descriptions: ["Fill it in free.", "Clients pay by card."],
      final_url: "https://example.com/cleaning", path1: "cleaning" };
    const campaign = { type: "create_campaign", name: "Cleaning Test", daily_budget: 20, end_date: "2030-12-03",
      negative_keywords: [{ text: "jobs", match_type: "PHRASE" }],
      sitelinks: [{ text: "Pricing", url: "https://example.com/pricing", description1: "Free to start", description2: "No card" }],
      ad_groups: [{ name: "Invoicing", default_max_cpc: 4, keywords: [{ text: "cleaning invoice", match_type: "PHRASE", max_cpc: 3 }], ads: [ad] }] };

    // Name clash and manual CPC with no bid are refused before anything is stored.
    await expect(propose([{ ...campaign, name: "Search" }])).rejects.toThrow('A campaign named "Search" already exists');
    await expect(propose([{ ...campaign, ad_groups: [{ ...campaign.ad_groups[0], default_max_cpc: undefined, keywords: [{ text: "x", match_type: "PHRASE" }] }] }]))
      .rejects.toThrow("Manual CPC needs a bid");

    const before = ads.mutations.length;
    const p = await propose([campaign]);
    expect(p.summary).toContain('Create Search campaign "Cleaning Test", PAUSED (nothing spends until you enable it): 20.00/day, manual CPC');
    expect(p.summary).toContain("ends 2030-12-03");
    expect(p.summary).toContain('"Invoicing" (1 keyword(s), bid 4.00, 1 ad(s) → https://example.com/cleaning)');
    // One atomic, dry-run request: budget → campaign (PAUSED) → criteria → sitelink → ad group → ad → keyword.
    const dry = ads.mutations.slice(before);
    expect(dry).toHaveLength(1);
    expect(dry[0]!.service).toBe("googleAds");
    expect(dry[0]!.validateOnly).toBe(true);
    const ops = dry[0]!.operations;
    expect(ops[1].campaignOperation.create).toMatchObject({ status: "PAUSED", campaignBudget: ops[0].campaignBudgetOperation.create.resourceName,
      endDateTime: "2030-12-03 23:59:59", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } });
    expect(ops.filter((o: any) => o.campaignCriterionOperation)).toHaveLength(3); // US, English, 1 negative
    expect(ops.find((o: any) => o.adGroupCriterionOperation).adGroupCriterionOperation.create.cpcBidMicros).toBe("3000000");

    const applied = await call(token, "apply_changes", { proposal_id: p.proposal_id });
    expect(applied.json.status).toBe("applied");
    const u = await call(token, "undo_changes", { proposal_id: p.proposal_id });
    expect(u.json.summary).toContain('Remove campaign "Cleaning Test" that Camberstack created ⚠');
    await call(token, "apply_changes", { proposal_id: u.json.proposal_id });
    expect(ads.removed).toContain("customers/1112223333/campaigns/501");

    // Keywords: duplicates of what's there are skipped; undo removes exactly what was added.
    const k = await propose([{ type: "add_keywords", ad_group_id: "20", keywords: [
      { text: "invoice", match_type: "BROAD" }, { text: "cleaning invoice", match_type: "PHRASE", max_cpc: 3 }] }]);
    expect(k.summary).toContain('Add 1 keyword(s) to ad group "AG" (campaign "Search"): "cleaning invoice" @ 3.00 (1 already present, skipped)');
    await call(token, "apply_changes", { proposal_id: k.proposal_id });
    const ku = await call(token, "undo_changes", { proposal_id: k.proposal_id });
    await call(token, "apply_changes", { proposal_id: ku.json.proposal_id });
    expect(ads.removed).toContain("customers/1112223333/adGroupCriteria/20~700");

    // Conversion goal: bid on SIGNUP only, undo restores PURCHASE.
    await expect(propose([{ type: "set_conversion_goal", campaign_id: "10", category: "PHONE_CALL_LEAD" }])).rejects.toThrow("No PHONE_CALL_LEAD goal");
    const g = await propose([{ type: "set_conversion_goal", campaign_id: "10", category: "SIGNUP" }]);
    expect(g.summary).toContain('Campaign "Search" counts and bids on SIGNUP conversions only (was: PURCHASE, SIGNUP)');
    await call(token, "apply_changes", { proposal_id: g.proposal_id });
    expect(ads.goals).toEqual({ PURCHASE: false, SIGNUP: true });
    const gu = await call(token, "undo_changes", { proposal_id: g.proposal_id });
    await call(token, "apply_changes", { proposal_id: gu.json.proposal_id });
    expect(ads.goals).toEqual({ PURCHASE: true, SIGNUP: true });
  });

  it("relays an app's conversions with the key owner's connection, only for the key's actions", async () => {
    const key = createRelayKey(db, "owner@example.com", "111-222-3333", ["7585493163"], "redbudway");
    const post = (body: object, k = key) => fetch(`${base}/v1/conversions`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify(body) });

    expect((await post({ conversion_action_id: "7585493163", gclid: "Cj0KCQjw_test_click" }, "csk_wrongwrongwrongwrongwrong")).status).toBe(401);
    expect((await post({ conversion_action_id: "999", gclid: "Cj0KCQjw_test_click" })).status).toBe(403);   // not this key's action
    expect((await post({ conversion_action_id: "7585493163" })).status).toBe(400);                          // no click id
    expect((await post({ conversion_action_id: "7585493163", gclid: "Cj0KCQjw_test_click", conversion_time: "2020-01-01T00:00:00Z" })).status).toBe(400);

    expect((await post({ conversion_action_id: "7585493163", gclid: "Cj0KCQjw_test_click", conversion_time: new Date().toISOString() })).status).toBe(202);
    expect((await post({ conversion_action_id: "7585493163", gclid: "Cj0KCQjw_test_click" })).status).toBe(202);   // duplicate: accepted, stored once
    expect((await post({ conversion_action_id: "7585493163", gclid: "STALE_CLICK_ID_0001", value: 5 })).status).toBe(202);
    await relay.flush();
    const sent = ads.uploads.flatMap((u) => u.conversions.map((c) => ({ cid: u.cid, ...c })));
    expect(sent.filter((c) => c.gclid === "Cj0KCQjw_test_click")).toHaveLength(1);
    expect(sent[0]).toMatchObject({ cid: "1112223333", conversionAction: "customers/1112223333/conversionActions/7585493163" });
    expect(sent[0].conversionDateTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00:00$/);
    const rows = db.prepare("SELECT click_id, uploaded_at IS NOT NULL up, error FROM relay_conversions ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { click_id: "Cj0KCQjw_test_click", up: 1, error: null },
      { click_id: "STALE_CLICK_ID_0001", up: 0, error: "rejected: The click is too old" },  // kept for the retrying sweep
    ]);
  });

  it("tunes bids, ads, bidding, URL suffix and conversion actions, each with an undo", async () => {
    const propose = async (changes: object[]) => { const r = await call(token, "propose_changes", { customer_id: "1112223333", changes }); if (r.isError) throw new Error(r.text); return r.json; };
    const last = () => ads.mutations.filter((m) => !m.validateOnly).at(-1)!;
    const applyUndo = async (id: string) => {
      await call(token, "apply_changes", { proposal_id: id });
      const u = await call(token, "undo_changes", { proposal_id: id });
      return u.json;
    };

    const bid = await propose([{ type: "set_ad_group_bid", ad_group_id: "20", max_cpc: 3 }]);
    expect(bid.summary).toContain('Set default max CPC of ad group "AG" (campaign "Search") from 1.00 to 3.00 ⚠ 3.0× the current bid');
    const bidUndo = await applyUndo(bid.proposal_id);
    expect(bidUndo.summary).toContain("from 3.00 to 1.00");
    await call(token, "apply_changes", { proposal_id: bidUndo.proposal_id });
    expect(ads.agBid).toBe("1000000");

    const kw = await propose([{ type: "set_keyword_bid", ad_group_id: "20", criterion_id: "30", max_cpc: 2 }]);
    expect(kw.summary).toContain("from the ad group's 1.00 to 2.00");
    const kwUndo = await applyUndo(kw.proposal_id);
    expect(kwUndo.summary).toContain("to the ad group's 1.00");
    await call(token, "apply_changes", { proposal_id: kwUndo.proposal_id });
    expect(last().operations[0]).toEqual({ update: { resourceName: "customers/1112223333/adGroupCriteria/20~30" }, updateMask: "cpc_bid_micros" });  // cleared

    const ad = await propose([{ type: "pause_ad", ad_group_id: "20", ad_id: "40" }]);
    expect(ad.summary).toContain('Pause ad 40 (→ https://example.com/old) in ad group "AG"');

    const strat = await propose([{ type: "set_bidding_strategy", campaign_id: "10", strategy: "MAXIMIZE_CLICKS", max_cpc_ceiling: 4 }]);
    expect(strat.summary).toContain('from manual CPC to maximize clicks (max 4.00/click) ⚠ Google re-learns');
    const stratUndo = await applyUndo(strat.proposal_id);
    expect(stratUndo.summary).toContain("back to manual CPC");
    await call(token, "apply_changes", { proposal_id: stratUndo.proposal_id });
    expect(last().operations[0]).toMatchObject({ update: { manualCpc: { enhancedCpcEnabled: false } }, updateMask: "manual_cpc.enhanced_cpc_enabled" });

    const sfx = await propose([{ type: "set_url_suffix", campaign_id: "10", suffix: "?utm_source=google&utm_term={keyword}" }]);
    expect(sfx.summary).toContain('from none to "utm_source=google&utm_term={keyword}"');

    const ca = await propose([{ type: "create_conversion_action", name: "Provider signup", category: "SIGNUP" }]);
    expect(ca.summary).toContain('Create conversion action "Provider signup" (SIGNUP, uploaded click ids, one per click, primary) ⚠');
    const cnt = await propose([{ type: "set_conversion_counting", conversion_action_id: "77", counting: "ONE_PER_CLICK" }]);
    expect(cnt.summary).toContain('"Signup" to count one conversion per click (was MANY_PER_CLICK)');
  });

  it("uploads one conversion for a first connection that came from our ad, and none otherwise", async () => {
    // A visitor lands from an ad: the click id is kept in a first-party cookie and the page isn't shared-cached.
    const land = await fetch(`${base}/google-ads-claude?gclid=Cj0KCQtest_click_1234`);
    expect(land.headers.get("set-cookie")).toMatch(/cs_click=gclid:Cj0KCQtest_click_1234;.*HttpOnly/);
    expect(land.headers.get("cache-control")).toContain("private");
    const cookie = "cs_click=gclid:Cj0KCQtest_click_1234";

    // An existing user reconnecting from the ad: cookie cleared, nothing uploaded.
    await connect(cookie);
    expect(lastCallbackCookies).toContain("cs_click=;");
    await new Promise((r) => setTimeout(r, 20));
    expect(conversionUploads).toHaveLength(0);

    // A brand-new user connecting from the ad: exactly one upload, to OUR account and action.
    googleUser.sub = "google-sub-ads"; googleUser.email = "new@example.com";
    try { await connect(cookie); } finally { googleUser.sub = "google-sub-1"; googleUser.email = "Owner@Example.com"; }
    await new Promise((r) => setTimeout(r, 50));
    expect(conversionUploads).toHaveLength(1);
    const c = conversionUploads[0].conversions[0];
    expect(c).toMatchObject({ gclid: "Cj0KCQtest_click_1234", conversionAction: "customers/9998887777/conversionActions/555" });
    expect(c.conversionDateTime).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+00:00$/);
    expect(db.prepare("SELECT uploaded_at FROM ad_conversions").get()).toMatchObject({ uploaded_at: expect.any(Number) });
    // Nothing about the user travels with it.
    expect(JSON.stringify(conversionUploads)).not.toContain("new@example.com");
  });

  it("refuses write GAQL", async () => {
    const r = await call(token, "run_gaql", { customer_id: "1112223333", query: "UPDATE campaign SET x" });
    expect(r.isError).toBe(true);
  });

  it("serves protected-resource metadata at the root path too, identical to the SDK's", async () => {
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    const sdk = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(root).toEqual(sdk);
    // Issuer is the bare origin (no trailing slash), and the two documents agree on it.
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.issuer).toBe(new URL(base).origin);
    expect(sdk.authorization_servers).toEqual([as.issuer]);
    expect(as.token_endpoint).toBe(`${new URL(base).origin}/token`);
    expect((await fetch(`${base}/geo-audit`)).status).toBe(410);
    expect((await fetch(`${base}/.well-known/glama.json`)).status).toBe(404);
  });

  it("documents every registered tool on /tools and in llms.txt", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = (await res.json()).result.tools;
    const names: string[] = listed.map((t: any) => t.name);
    // /tools shows each parameter's description, so every one needs one.
    for (const t of listed) for (const [k, v] of Object.entries<any>(t.inputSchema.properties ?? {})) expect(v.description, `${t.name}.${k}`).toBeTruthy();
    const page = await (await fetch(`${base}/tools`)).text();
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    for (const n of names) {
      expect(page, n).toContain(`id="${n}"`);
      expect(llms, n).toContain(n);
    }
    expect(page).toContain(`${names.length} tools`);
    // Parameters come from the schemas: defaults and descriptions, not hand-written copy.
    expect(page).toContain("<code>location_ids</code>");
    expect(page).toContain("Default [&quot;2840&quot;].");
    expect(page).toContain("https://github.com/awilliams-2020/camberstack-mcp");
    expect(page).toContain('<span class="pill act">Needs your go-ahead</span>');
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/tools`);
  });

  it("serves the Claude guide and lists it in the sitemap", async () => {
    const g = await fetch(`${base}/google-ads-claude`);
    expect(g.status).toBe(200);
    const html = await g.text();
    expect(html).toContain("<h1>Connect Google Ads to Claude</h1>");
    expect(html).toContain(`${base}/mcp`);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-ads-claude`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-ads-claude"');
    const c = await fetch(`${base}/google-ads-chatgpt`);
    expect(c.status).toBe(200);
    expect(await c.text()).toContain("Create MCP App");
    const claude = await (await fetch(`${base}/google-ads-claude`)).text() + await (await fetch(`${base}/google-ads-chatgpt`)).text()
      + await (await fetch(`${base}/google-ads-gemini`)).text();
    for (const m of claude.matchAll(/src="(\/shots\/[^"]+)"/g)) {
      const img = await fetch(`${base}${m[1]}`);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toContain("image/webp");
    }
    expect(claude).toContain('src="/shots/claude-1.webp"');
    expect((await fetch(`${base}/shots/..%2Fserver.ts`)).status).toBe(404);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-ads-chatgpt`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-ads-chatgpt"');
    expect(claude).toContain('src="/shots/gemini-3.webp"');
    // Gemini doesn't complete the connection yet: the guide stays up but unlisted.
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).not.toContain(`${base}/google-ads-gemini`);
    expect(await (await fetch(`${base}/`)).text()).not.toContain('href="/google-ads-gemini"');
    expect(await (await fetch(`${base}/google-ads-gemini`)).text()).toContain('<meta name="robots" content="noindex">');
  });

  it("hands back a Gemini-sized state (~1.4k chars, base64url) byte for byte", async () => {
    const state = randomBytes(1050).toString("base64url");
    expect(await connect(undefined, state)).toBeTruthy();
  });

  it("registers Gemini's relay as a public client, everyone else with a secret", async () => {
    const reg = (redirect_uris: string[]) => fetch(`${base}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris, client_name: "Google", token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const g = await reg(["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"].flatMap((h) =>
      ["r", "a"].map((k) => `https://${h}.googleusercontent.com/${k}/user_bound_custom-mcp-1-camberstack_io`)));
    expect(g.status).toBe(201);
    expect(g.body.token_endpoint_auth_method).toBe("none");
    expect(g.body.client_secret).toBeUndefined();
    const other = await reg(["https://claude.ai/api/mcp/auth_callback"]);
    expect(other.body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(other.body.client_secret).toBeTruthy();
    const mixed = await reg(["https://oauth-redirect.googleusercontent.com/r/x", "https://evil.example/cb"]);
    expect(mixed.body.client_secret).toBeTruthy();
  });

  it("serves the pages Google's brand verification reads", async () => {
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain('href="/privacy"');
    const privacy = await (await fetch(`${base}/privacy`)).text();
    expect(privacy).toContain("Limited Use");
    expect(privacy).toContain("auth/adwords");
    const logo = await fetch(`${base}/logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/png");
  });
});

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt(key, "secret"), b = encrypt(key, "secret");
    expect(a).not.toBe(b);
    expect(decrypt(key, a)).toBe("secret");
  });
});
