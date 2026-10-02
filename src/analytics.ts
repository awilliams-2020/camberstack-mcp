/**
 * Self-hosted Matomo for the public pages only. Nothing from Google Ads ever goes here: tool usage is
 * logged in our own SQLite (tool_calls), and the only server-side event is "a Google Ads account
 * connected", with no account, email or id attached.
 *
 * Ported from the GEO app on this domain (~/camberstack/src/analytics.js, Matomo site 7), where each
 * rule below was learned the hard way:
 *  - Page views come from a first-party beacon (/e.js → POST /e), not from server requests. Crawlers
 *    all claim to be Chrome, so server-side page views were effectively all bots.
 *  - `cip` (the visitor's IP, so the visit geolocates to them and not this container) is rejected
 *    with HTTP 400 unless `token_auth` with write access to the site comes with it.
 *  - Matomo silently drops a request with an empty `ua`.
 *  - AI-assistant fetches go to the BotTracking plugin with `recMode=1` (NOT `bots=1`, which records
 *    the bot as a human visit), and only these 7 user agents are stored; keep AI_FETCHER in step with
 *    $aiAssistantPatterns in Matomo's plugins/BotTracking/BotDetector.php.
 * Visits are grouped by a salted hash of IP + user agent; the salt changes daily and lives only in
 * memory. The /privacy page states all of this; keep the two in step.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { clientIp } from "./http.js";

export interface AnalyticsConfig {
  matomoUrl: string;
  siteId: string;
  token: string;
  site: string;
  fetch?: typeof fetch;
}

const BOT = /bot|crawler|spider|crawling|slurp|curl|wget|python-|node-fetch|headless|monitor|preview|scanner|go-http-client|axios|okhttp|java\/|libwww|httpx|aiohttp|scrapy/i;
const AI_FETCHER = /(ChatGPT-User|MistralAI-User|Gemini-Deep-Research|Claude-User|Perplexity-User|Google-GeminiNotebook|Google-NotebookLM)/i;

/** No cookie, no storage, no identifier. Skips navigator.webdriver (unstealthed headless browsers). */
export const BEACON_JS = `(()=>{var n=navigator;if(n.webdriver||!n.sendBeacon)return;
n.sendBeacon('/e',new URLSearchParams({t:'pv',p:location.pathname,x:document.referrer}))})();`;

/** Pure, so it is unit-testable. Returns null for anything malformed. */
export function parseBeacon(form: Record<string, unknown>): { page: string; ref: string } | null {
  const page = String(form.p ?? "");
  if (form.t !== "pv" || !/^\/[A-Za-z0-9_\-/.]{0,80}$/.test(page)) return null;
  const ref = String(form.x ?? "");
  if (ref && !/^https?:\/\/\S{1,500}$/.test(ref)) return null;
  return { page, ref };
}

export class Analytics {
  private salt = randomBytes(16);
  private saltDay = "";
  constructor(private cfg: AnalyticsConfig) {}

  get enabled(): boolean { return Boolean(this.cfg.matomoUrl && this.cfg.siteId); }

  private who(req: Request): { ua: string; ip: string; cid: string } | null {
    const ua = String(req.headers["user-agent"] ?? "");
    if (!ua || BOT.test(ua)) return null;
    const ip = clientIp(req);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.saltDay) { this.salt = randomBytes(16); this.saltDay = today; }
    const cid = createHash("sha256").update(this.salt).update(ip).update(ua).digest("hex").slice(0, 16);
    return { ua, ip, cid };
  }

  private send(params: Record<string, string>, ip: string): void {
    if (!this.enabled) return;
    const attribution: Record<string, string> = ip && this.cfg.token ? { cip: ip, token_auth: this.cfg.token } : {};
    const body = new URLSearchParams({ idsite: this.cfg.siteId, rec: "1", apiv: "1", send_image: "0", rand: String(Math.random()), ...attribution, ...params });
    (this.cfg.fetch ?? fetch)(`${this.cfg.matomoUrl.replace(/\/+$/, "")}/matomo.php`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(3000),
    }).catch(() => { /* analytics must never affect a request */ });
  }

  pageview(req: Request, page: string, ref: string): void {
    const w = this.who(req);
    if (!w) return;
    this.send({ url: `${this.cfg.site}${page}`, action_name: page, urlref: ref, ua: w.ua,
      lang: String(req.headers["accept-language"] ?? ""), cid: w.cid }, w.ip);
  }

  /** Server-side outcome event, e.g. a Google Ads account connected. Same browser → same daily visitor. */
  event(req: Request, action: string): void {
    const w = this.who(req);
    if (!w) return;
    this.send({ url: `${this.cfg.site}/`, e_c: "camberstack", e_a: action, ua: w.ua, cid: w.cid }, w.ip);
  }

  /** An AI assistant fetching a public page because a user asked it something. Not a visit. */
  aiFetch(req: Request, res: Response): void {
    const ua = String(req.headers["user-agent"] ?? "");
    if (req.method !== "GET" || !AI_FETCHER.test(ua)) return;
    const ip = clientIp(req);
    res.once("finish", () => {
      const bytes = Number(res.getHeader("content-length"));
      this.send({ url: `${this.cfg.site}${req.path}`, recMode: "1", http_status: String(res.statusCode),
        ...(Number.isFinite(bytes) ? { bw_bytes: String(bytes) } : {}), ua }, ip);
    });
  }
}
