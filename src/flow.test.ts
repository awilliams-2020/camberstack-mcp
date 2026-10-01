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

const key = randomBytes(32);
const idToken = (sub: string, email: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, email, email_verified: true })).toString("base64url")}.s`;

/** Google's token endpoint. */
const googleFetch: typeof fetch = async (url) => {
  if (String(url).includes("oauth2.googleapis.com/token")) {
    return new Response(JSON.stringify({
      access_token: "g-access", expires_in: 3600, refresh_token: "g-refresh",
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords",
      id_token: idToken("google-sub-1", "Owner@Example.com"),
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
  async listAccessibleCustomers() { return ["1112223333"]; }
  async search(_cid: string, q: string): Promise<any[]> {
    if (q.includes("FROM customer_client")) {
      return [{ customerClient: { id: "1112223333", descriptiveName: "Acme", currencyCode: "USD", manager: false, level: 0 } }];
    }
    if (q.includes("FROM campaign_criterion")) {
      return this.negatives.map((n) => ({ campaign: { id: "10" }, campaignCriterion: { keyword: { text: n.text, matchType: n.matchType } } }));
    }
    if (q.includes("FROM ad_group_criterion")) {
      return [{ adGroupCriterion: { status: this.kwStatus, keyword: { text: "invoice", matchType: "BROAD" } }, adGroup: { name: "AG" }, campaign: { name: "Search" } }];
    }
    if (q.includes("FROM campaign")) {
      return [{ campaign: { id: "10", name: "Search", status: this.campaignStatus, advertisingChannelType: "SEARCH" },
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
  async mutate(_cid: string, service: string, operations: any[], opts: { validateOnly?: boolean } = {}) {
    this.mutations.push({ service, operations, validateOnly: !!opts.validateOnly });
    if (opts.validateOnly) return { results: [] };
    return {
      results: operations.map((op, i) => {
        if (op.create?.negative) {
          const rn = `customers/1112223333/campaignCriteria/10~${900 + this.negatives.length + i}`;
          this.negatives.push({ text: op.create.keyword.text, matchType: op.create.keyword.matchType, rn });
          return { resourceName: rn };
        }
        if (op.remove) { this.negatives = this.negatives.filter((n) => n.rn !== op.remove); return { resourceName: op.remove }; }
        if (op.update?.status && service === "campaigns") { this.campaignStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        if (op.update?.status) { this.kwStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        return { resourceName: op.update?.resourceName };
      }),
    };
  }
}

/** Stripe, just enough of it: Checkout, session lookup, the sweep's list, subscriptions, the portal. */
const stripe = { subStatus: "active", checkouts: [] as URLSearchParams[] };
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
  if (u.startsWith("checkout/sessions?")) return j({ data: [] });
  if (u === "subscriptions/sub_1") return j({ id: "sub_1", status: stripe.subStatus });
  if (u.startsWith("billing_portal/configurations")) return j({ data: [{ id: "bpc_1", is_default: false, active: true }] });
  if (u === "billing_portal/sessions") {
    expect((init?.body as URLSearchParams).get("configuration")).toBe("bpc_1");
    return j({ url: "https://billing.stripe.com/p/session_1" });
  }
  throw new Error(`unexpected stripe ${u}`);
};

let app: ReturnType<typeof createApp>;
let server: Server;
let base = "";
const ads = new FakeAds();
const db = openDb(":memory:");

beforeAll(async () => {
  const cfg: Config = {
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: key,
    google: { clientId: "gid", clientSecret: "gsecret" },
    freeApplies: 3, stripe: { secretKey: "sk_test_x", proPriceId: "price_pro" }, proEmails: new Set(), adminEmails: new Set(["owner@example.com"]), gitSha: "test", gitCommitDate: "",
  };
  // Bind first so baseUrl (the OAuth issuer) is the real test origin.
  server = await new Promise<Server>((resolve) => { const s = createApp(cfg, db).listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.close();
  server = await new Promise<Server>((resolve) => {
    app = createApp({ ...cfg, baseUrl: base, adminUrl: base.replace("localhost", "127.0.0.1") }, db, { fetch: googleFetch, stripeFetch, adsFactory: () => ads as any });
    const s = app.listen(Number(new URL(base).port), () => resolve(s));
  });
});
afterAll(() => { server?.close(); });

async function connect(): Promise<string> {
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
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "ads" }).toString();
  const toGoogle = await fetch(auth, { redirect: "manual" });
  expect(toGoogle.status).toBe(302);
  const g = new URL(toGoogle.headers.get("location")!);
  expect(g.host).toBe("accounts.google.com");
  expect(g.searchParams.get("scope")).toContain("adwords");

  const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" });
  expect(back.status).toBe(302);
  const cb = new URL(back.headers.get("location")!);
  expect(cb.searchParams.get("state")).toBe("xyz");

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
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["list_accounts", "find_wasted_spend", "propose_changes", "apply_changes", "undo_changes"]));
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

  it("finds wasted spend and suggests a phrase negative", async () => {
    const r = await call(token, "find_wasted_spend", { customer_id: "111-222-3333" });
    expect(r.isError).toBe(false);
    expect(r.json.tracking.status).toBe("ok");
    expect(r.json.suggestedNegatives).toContainEqual(expect.objectContaining({ text: "free", matchType: "PHRASE" }));
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

  it("gives 3 free applied changes, then a personal upgrade link; undo is never paywalled", async () => {
    // The previous test used 1 apply (its undo doesn't count).
    const negative = async (text: string) => {
      const p = await call(token, "propose_changes", { customer_id: "1112223333",
        changes: [{ type: "add_negative_keywords", campaign_id: "10", keywords: [{ text, match_type: "PHRASE" }] }] });
      return p.json.proposal_id as string;
    };
    expect((await call(token, "apply_changes", { proposal_id: await negative("jobs") })).json.free_applies_left).toBe(1);
    const third = await negative("login");
    const last = (await call(token, "apply_changes", { proposal_id: third })).json;
    expect(last.free_applies_left).toBe(0);
    expect(last.upgrade_url).toContain("/upgrade?t=");

    const fourth = await negative("how to");
    const blocked = await call(token, "apply_changes", { proposal_id: fourth });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("3 free applied changes");
    const link = blocked.text.match(/https?:\/\/\S+\/upgrade\?t=[\w.-]+/)![0];
    expect(ads.negatives.map((n) => n.text)).not.toContain("how to");

    // Undo still works at the limit.
    const u = await call(token, "undo_changes", { proposal_id: third });
    expect((await call(token, "apply_changes", { proposal_id: u.json.proposal_id })).json.status).toBe("applied");

    const plan = await call(token, "billing", {});
    expect(plan.json).toMatchObject({ plan: "free", free_applies_left: 0 });
    expect(plan.json.upgrade_url).toContain("/upgrade?t=");

    // A tampered link is refused; the real one goes to Stripe Checkout as a subscription for this user.
    expect((await fetch(link.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { redirect: "manual" })).status).toBe(400);
    const go = await fetch(link, { redirect: "manual" });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toContain("checkout.stripe.com");
    const form = stripe.checkouts.at(-1)!;
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer_email")).toBe("owner@example.com");

    const done = await fetch(`${base}/upgraded?session_id=cs_test_1`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("on Camberstack Pro");
    const now4 = await call(token, "apply_changes", { proposal_id: fourth });
    expect(now4.json.status).toBe("applied");
    expect(now4.json.free_applies_left).toBeUndefined();

    const pro = await call(token, "billing", {});
    expect(pro.json.plan).toBe("pro");
    const portal = await fetch(pro.json.manage_billing, { redirect: "manual" });
    expect(portal.headers.get("location")).toContain("billing.stripe.com");

    // Cancelled at period end: the hourly sweep drops the plan back to free.
    stripe.subStatus = "canceled";
    await (app.locals.billing as any).sweep();
    expect((await call(token, "billing", {})).json.plan).toBe("free");
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
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ACTION_NOT_PERMITTED");
  });

  it("logs each tool call by name, without arguments or results", async () => {
    const rows = db.prepare("SELECT * FROM tool_calls ORDER BY id").all() as any[];
    const tools = rows.map((r) => r.tool);
    expect(tools).toContain("find_wasted_spend");
    expect(tools).toContain("apply_changes");
    const wasted = rows.find((r) => r.tool === "find_wasted_spend");
    expect(wasted).toMatchObject({ ok: 1, error: null, customer_id: "1112223333" });
    expect(wasted.client_id).toBeTruthy();
    expect(wasted.bytes).toBeGreaterThan(0);
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
    expect(html).toContain("find_wasted_spend");
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

  it("refuses write GAQL", async () => {
    const r = await call(token, "run_gaql", { customer_id: "1112223333", query: "UPDATE campaign SET x" });
    expect(r.isError).toBe(true);
  });

  it("serves protected-resource metadata at the root path too, identical to the SDK's", async () => {
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    const sdk = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(root).toEqual(sdk);
    expect((await fetch(`${base}/geo-audit`)).status).toBe(410);
    expect((await fetch(`${base}/.well-known/glama.json`)).status).toBe(404);
  });

  it("serves the Claude guide and lists it in the sitemap", async () => {
    const g = await fetch(`${base}/google-ads-claude`);
    expect(g.status).toBe(200);
    const html = await g.text();
    expect(html).toContain("<h1>Connect Google Ads to Claude</h1>");
    expect(html).toContain(`${base}/mcp`);
    expect(await (await fetch(`${base}/sitemap.xml`)).text()).toContain(`${base}/google-ads-claude`);
    expect(await (await fetch(`${base}/`)).text()).toContain('href="/google-ads-claude"');
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
