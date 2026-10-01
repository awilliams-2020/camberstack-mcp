/**
 * Our own Google Ads campaign's conversions, measured without a Google tag (the site promises no
 * third-party scripts). Same pattern as theqrcode and redbudway: keep the ad click id, upload it when
 * the thing we pay for happens.
 *
 *  1. A visitor lands from one of our ads: Google appends gclid (or gbraid/wbraid on iOS) to the URL.
 *     captureClick() keeps it in a first-party, HttpOnly cookie for 90 days (the conversion window).
 *  2. The same browser finishes "Connect Google Ads" (the OAuth callback): record() ties the click to
 *     that user, once, on their FIRST connection only.
 *  3. upload() sends it to OUR Ads account (uploadClickConversions) with the operator's own
 *     credentials (CONV_ADS_* in .env), never a user's: the user's Google Ads data is not involved,
 *     and a disconnect test can't silently stop tracking. Failures stay in the table and the hourly
 *     sweep retries them, so nothing is lost while credentials are being fixed.
 */
import type { Request, Response } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { ADS_API, refreshGoogleToken } from "./google.js";

export interface ConversionConfig {
  customerId: string;
  /** Manager the operator's login reaches the account through, if any. */
  loginCustomerId?: string;
  actionId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
}

const COOKIE = "cs_click";
const MAX_AGE = 90 * 86400;
const KINDS = ["gclid", "gbraid", "wbraid"] as const;
type Kind = typeof KINDS[number];
const MAX_ATTEMPTS = 8;

export class AdConversions {
  constructor(private db: DB, private cfg: ConversionConfig | undefined, private secure: boolean, private f: typeof fetch = fetch) {}

  /** On any page view: keep an ad click id if the URL carries one. Returns true when it set the cookie. */
  captureClick(req: Request, res: Response): boolean {
    for (const kind of KINDS) {
      const v = req.query[kind];
      if (typeof v === "string" && /^[A-Za-z0-9_\-.~]{10,300}$/.test(v)) {
        res.append("Set-Cookie", `${COOKIE}=${kind}:${v}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`);
        res.setHeader("Cache-Control", "private, no-store");  // a page that sets a per-visitor cookie must not be shared-cached
        return true;
      }
    }
    return false;
  }

  /** After a successful Google Ads connection: record the conversion for a first-time user, then try to upload it. */
  record(req: Request, res: Response, userId: string, firstConnection: boolean): void {
    const raw = /(?:^|;\s*)cs_click=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!raw) return;
    res.append("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${this.secure ? "; Secure" : ""}`);
    if (!firstConnection) return;
    const [kind, ...rest] = decodeURIComponent(raw).split(":");
    const clickId = rest.join(":");
    if (!KINDS.includes(kind as Kind) || !clickId) return;
    this.db.prepare(`INSERT OR IGNORE INTO ad_conversions (user_id, kind, click_id, at) VALUES (?, ?, ?, ?)`)
      .run(userId, kind, clickId, now());
    void this.flush().catch(() => { /* retried by the sweep */ });
  }

  /** Upload every pending conversion (new ones, and failures under the retry cap). */
  async flush(): Promise<void> {
    if (!this.cfg) return;
    const pending = this.db.prepare(`SELECT * FROM ad_conversions WHERE uploaded_at IS NULL AND attempts < ? ORDER BY at`).all(MAX_ATTEMPTS) as
      { user_id: string; kind: Kind; click_id: string; at: number }[];
    if (!pending.length) return;
    let token: string;
    try {
      token = (await refreshGoogleToken({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }, this.cfg.refreshToken, this.f)).access_token;
    } catch (e) {
      for (const p of pending) this.fail(p.user_id, `token: ${(e as Error).message}`);
      return;
    }
    for (const p of pending) {
      try {
        await this.upload(token, p.kind, p.click_id, p.at);
        this.db.prepare("UPDATE ad_conversions SET uploaded_at = ?, error = NULL, attempts = attempts + 1 WHERE user_id = ?").run(now(), p.user_id);
      } catch (e) {
        this.fail(p.user_id, (e as Error).message);
      }
    }
  }

  private fail(userId: string, error: string): void {
    this.db.prepare("UPDATE ad_conversions SET error = ?, attempts = attempts + 1 WHERE user_id = ?").run(error.slice(0, 500), userId);
  }

  private async upload(token: string, kind: Kind, clickId: string, at: number): Promise<void> {
    const c = this.cfg!;
    // Google's required format: "yyyy-MM-dd HH:mm:ss+00:00".
    const when = new Date(at * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00:00");
    const res = await this.f(`${ADS_API}/customers/${c.customerId}:uploadClickConversions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "developer-token": c.developerToken, "Content-Type": "application/json",
        ...(c.loginCustomerId ? { "login-customer-id": c.loginCustomerId } : {}),
      },
      body: JSON.stringify({
        conversions: [{ [kind]: clickId, conversionAction: `customers/${c.customerId}/conversionActions/${c.actionId}`, conversionDateTime: when }],
        partialFailure: true,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    // partialFailure: a 200 can still carry a per-conversion rejection (bad or too-old click id).
    const parsed = JSON.parse(body || "{}") as { partialFailureError?: { message?: string } };
    if (parsed.partialFailureError) throw new Error(`rejected: ${parsed.partialFailureError.message ?? JSON.stringify(parsed.partialFailureError).slice(0, 300)}`);
  }
}
