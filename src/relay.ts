/**
 * Keyword relay: lets the operator's research scripts price keywords through a Camberstack connection,
 * holding a scoped key instead of a Google token.
 *
 *   POST /v1/keyword-metrics   Authorization: Bearer csk_…   (a key created with relay-admin create-keywords)
 *   { "keywords": ["…", …up to 10000], "location_ids": ["2840"], "language_id": "1000", "months": 25 }
 *   → { "results": [...] }: Keyword Planner's generateKeywordHistoricalMetrics results as Google returns them
 *   (bids in micros, monthlySearchVolumes over `months`), for project-research's pricing scripts, which do
 *   their own trend math. The key acts through its owner's stored Google connection.
 *
 * Keys are created on the box, never over HTTP. This is for the operator; it is not offered to users.
 *
 * Until 2026-10-16 this file also relayed the apps' ad conversions (POST /v1/conversions). Google now
 * refuses UploadClickConversions from Camberstack's Cloud project ("use the Data Manager API"), so that
 * moved to its own service, ~/conversions-relay (http://conversions-relay:3000). Keys created for it here
 * carry the scope "conversions" and are refused by this endpoint.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { now, type DB, type UserRow } from "./db.js";
import { AdsClient } from "./google.js";
import { UserSession, type SessionDeps } from "./session.js";

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const MONTH_ENUM = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

const KeywordBody = z.object({
  keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(10_000),
  location_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(10).default(["2840"]),
  language_id: z.string().regex(/^\d+$/).default("1000"),
  months: z.number().int().min(12).max(48).default(25).describe("history window; >12 lets a caller compare the same months a year apart"),
});

interface KeyRow { id: string; user_id: string; customer_id: string; login_customer_id: string | null; label: string; scopes: string }

/** A keyword_metrics key for the user with this email ("auto": whoever last used the account successfully). */
export function createRelayKey(db: DB, email: string, customerId: string, label: string, loginCustomerId: string | null = null): string {
  const cid = customerId.replace(/-/g, "");
  const user = (email === "auto"
    ? db.prepare(`SELECT u.id, u.email FROM tool_calls t JOIN users u ON u.id = t.user_id
        WHERE t.customer_id = ? AND t.ok = 1 AND u.enc_refresh IS NOT NULL ORDER BY t.at DESC LIMIT 1`).get(cid)
    : db.prepare("SELECT id, email FROM users WHERE lower(email) = lower(?)").get(email)) as { id: string; email: string } | undefined;
  if (!user) throw new Error(email === "auto" ? `No connected Camberstack user has used account ${cid}.` : `No Camberstack user ${email}; connect Camberstack with that Google login first.`);
  console.error(`key owner: ${user.email.replace(/^(.).*(@.*)$/, "$1***$2")}`);
  const key = `csk_${randomBytes(32).toString("base64url")}`;
  db.prepare(`INSERT INTO relay_keys (id, key_hash, user_id, customer_id, login_customer_id, label, action_ids, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, '', 'keyword_metrics', ?)`)
    .run(randomUUID(), hash(key), user.id, cid, loginCustomerId?.replace(/-/g, "") || null, label, now());
  return key;
}

export class Relay {
  constructor(private deps: SessionDeps, private f: typeof fetch = fetch) {}

  /** The key on this request, if it's live and may price keywords; otherwise answers 401/403 and returns undefined. */
  private keyFor(req: Request, res: Response): KeyRow | undefined {
    const key = /^Bearer (csk_[A-Za-z0-9_-]{20,})$/.exec(req.get("authorization") ?? "")?.[1];
    const k = key && this.deps.db.prepare("SELECT * FROM relay_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(key)) as KeyRow | undefined;
    if (!k) { res.status(401).json({ error: "invalid or revoked key" }); return undefined; }
    if (!k.scopes.split(",").includes("keyword_metrics")) { res.status(403).json({ error: `this key's scopes are ${k.scopes}, not keyword_metrics` }); return undefined; }
    return k;
  }

  /** Keyword Planner historical metrics with the key owner's connection: 200 { results }, Google's shape. */
  keywordMetrics = async (req: Request, res: Response): Promise<void> => {
    const k = this.keyFor(req, res);
    if (!k) return;
    const parsed = KeywordBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }); return; }
    const b = parsed.data;
    const user = this.deps.db.prepare("SELECT * FROM users WHERE id = ?").get(k.user_id) as UserRow | undefined;
    if (!user?.enc_refresh) { res.status(503).json({ error: "key owner is not connected to Google; reconnect Camberstack" }); return; }
    const session = new UserSession(this.deps, user);
    const ads = this.deps.adsFactory?.(user) ?? new AdsClient(() => session.googleAccessToken(), this.deps.google.developerToken, this.f);
    // Planner lags a month or two, so ending the range this month costs nothing and never cuts the newest data.
    const d = new Date(), end = d.getUTCFullYear() * 12 + d.getUTCMonth(), start = end - b.months;
    const ym = (n: number) => ({ year: Math.floor(n / 12), month: MONTH_ENUM[n % 12] });
    try {
      const out = await ads.keywordPlan(k.customer_id, "generateKeywordHistoricalMetrics", {
        keywords: [...new Set(b.keywords)],
        language: `languageConstants/${b.language_id}`,
        geoTargetConstants: b.location_ids.map((id) => `geoTargetConstants/${id}`),
        keywordPlanNetwork: "GOOGLE_SEARCH", includeAdultKeywords: false,
        historicalMetricsOptions: { yearMonthRange: { start: ym(start), end: ym(end) } },
      }, k.login_customer_id);
      this.deps.db.prepare("UPDATE relay_keys SET last_used_at = ? WHERE id = ?").run(now(), k.id);
      res.json({ results: out.results ?? [] });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message.slice(0, 1000) });
    }
  };
}
