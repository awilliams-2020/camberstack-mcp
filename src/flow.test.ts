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
      return [{ campaign: { id: "10", name: "Search", status: "ENABLED", advertisingChannelType: "SEARCH" },
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
        if (op.update?.status) { this.kwStatus = op.update.status; return { resourceName: op.update.resourceName }; }
        return { resourceName: op.update?.resourceName };
      }),
    };
  }
}

let server: Server;
let base = "";
const ads = new FakeAds();
const db = openDb(":memory:");

beforeAll(async () => {
  const cfg: Config = {
    baseUrl: "http://localhost", port: 0, dataDir: ":memory:", encryptionKey: key,
    google: { clientId: "gid", clientSecret: "gsecret" },
    applyRequiresPro: false, proEmails: new Set(), adminEmails: new Set(["owner@example.com"]), gitSha: "test", gitCommitDate: "",
  };
  // Bind first so baseUrl (the OAuth issuer) is the real test origin.
  server = await new Promise<Server>((resolve) => { const s = createApp(cfg, db).listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.close();
  server = await new Promise<Server>((resolve) => {
    const s = createApp({ ...cfg, baseUrl: base }, db, { fetch: googleFetch, adsFactory: () => ads as any })
      .listen(Number(new URL(base).port), () => resolve(s));
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
    const names = (await res.json()).result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_accounts", "find_wasted_spend", "propose_changes", "apply_changes", "undo_changes"]));
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

  it("keeps /admin behind a Google sign-in for ADMIN_EMAILS, asking for identity only", async () => {
    const gate = await fetch(`${base}/admin`, { redirect: "manual" });
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe("/admin/login");
    const login = await fetch(`${base}/admin/login`, { redirect: "manual" });
    const g = new URL(login.headers.get("location")!);
    expect(g.searchParams.get("scope")).toBe("openid email");
    const back = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" });
    expect(back.status).toBe(302);
    const cookie = back.headers.get("set-cookie")!.split(";")[0]!;
    expect(back.headers.get("set-cookie")).toContain("HttpOnly");
    const page = await fetch(`${base}/admin?days=30&internal=1`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("find_wasted_spend");
    expect(html).toContain("owner@example.com");
    // The operator's own account is internal: hidden unless asked for.
    const json = await (await fetch(`${base}/admin?format=json`, { headers: { cookie } })).json();
    expect(json.funnel.all.connected).toBe(0);
    // A replayed state is refused.
    const replay = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`, { redirect: "manual" });
    expect(replay.status).toBe(400);
    expect((await fetch(`${base}/admin`, { headers: { cookie: "cs_admin=forged" }, redirect: "manual" })).status).toBe(302);
  });

  it("refuses write GAQL", async () => {
    const r = await call(token, "run_gaql", { customer_id: "1112223333", query: "UPDATE campaign SET x" });
    expect(r.isError).toBe(true);
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
