/**
 * Where a user first came from, kept on the user at their first connection so the admin can split connects by
 * source. A date window can't: organic connects run about one a day, so a paid test's connects (the Reddit test,
 * projects/camberstack/REDDIT-ADS.md) would be indistinguishable from them.
 *
 * First touch: the cookie is set on the first tagged landing and never overwritten, for 90 days. First-party and
 * HttpOnly, same as adconversions.ts; no pixel (the site promises no third-party scripts). Kept: utm_source (or
 * "google-ads" for an auto-tagged Google click), utm_campaign, utm_content, and Reddit's click id rdt_cid, which a
 * later Conversions API upload would need.
 */
import type { Request, Response } from "express";
import type { DB } from "./db.js";
import { readCookie } from "./http.js";

const COOKIE = "cs_src";
const MAX_AGE = 90 * 86400;
const TAG = /^[\w .:-]{1,100}$/;
const CLICK = /^[A-Za-z0-9_\-.~]{10,300}$/;

export interface Touch { source: string; campaign: string | null; content: string | null; click: string | null }

const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);

/** The touch a landing URL's query carries, or null when it carries none. Pure, so it is unit-testable. */
export function touchOf(query: Request["query"]): Touch | null {
  const click = str(query.rdt_cid, CLICK);
  const ads = ["gclid", "gbraid", "wbraid"].some((k) => typeof query[k] === "string");
  const source = str(query.utm_source, TAG)?.toLowerCase() ?? (click ? "reddit" : ads ? "google-ads" : null);
  if (!source) return null;
  return { source, campaign: str(query.utm_campaign, TAG), content: str(query.utm_content, TAG), click };
}

export class FirstTouch {
  constructor(private db: DB, private secure: boolean) {}

  /** On any page view: keep the first tagged landing. Returns true when it set the cookie. */
  capture(req: Request, res: Response): boolean {
    if (readCookie(req, COOKIE)) return false;
    const t = touchOf(req.query);
    if (!t) return false;
    const v = new URLSearchParams(Object.entries(t).filter(([, x]) => x) as [string, string][]).toString();
    res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(v)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`);
    res.setHeader("Cache-Control", "private, no-store");  // a page that sets a per-visitor cookie must not be shared-cached
    return true;
  }

  /** After a successful connection: store the touch on a first-time user. The cookie is cleared either way. */
  record(req: Request, res: Response, userId: string, firstConnection: boolean): void {
    const raw = readCookie(req, COOKIE);
    if (!raw) return;
    res.append("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${this.secure ? "; Secure" : ""}`);
    if (!firstConnection) return;
    const p = new URLSearchParams(raw);
    const source = str(p.get("source"), TAG);
    if (!source) return;
    this.db.prepare("UPDATE users SET src_source = ?, src_campaign = ?, src_content = ?, src_click = ? WHERE id = ? AND src_source IS NULL")
      .run(source, str(p.get("campaign"), TAG), str(p.get("content"), TAG), str(p.get("click"), CLICK), userId);
  }
}
