/**
 * "Sign in with Google" for our own web pages (/admin, /account): identity only (openid email), no Ads
 * scope, no refresh token. It reuses the registered redirect URI (/oauth/google/callback); each page's
 * states carry its own prefix and server.ts routes the callback by prefix, so the verified OAuth client
 * never changes. Sessions are random tokens stored as hashes, in an HttpOnly cookie scoped to the page.
 */
import type { Request, Response } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { exchangeGoogleCode, googleSignInUrl, idTokenClaims, type GoogleCreds } from "./google.js";

export interface SignInDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  fetch?: typeof fetch;
}

export class SignIn {
  private readonly redirectUri: string;
  private readonly secure: boolean;

  /**
   * `siteUrl` is the origin the page lives on (the admin page has its own host); Google always returns
   * to the main site's registered callback, which forwards here, so the cookie lands on the page's host.
   */
  constructor(private d: SignInDeps, readonly prefix: string, private cookieName: string, private path: string, private ttl: number,
    private siteUrl = d.baseUrl) {
    this.redirectUri = `${d.baseUrl}/oauth/google/callback`;
    this.secure = siteUrl.startsWith("https://");
  }

  /** Absolute URL server.ts forwards Google's callback to; under the cookie's path, on the page's host. */
  get callbackUrl(): string { return `${this.siteUrl}${this.path === "/" ? "" : this.path}/callback`; }

  owns(state: unknown): boolean { return typeof state === "string" && state.startsWith(this.prefix); }

  /** Redirect the browser to Google. */
  start(res: Response): void {
    const id = this.prefix + randomToken(24);
    this.d.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, ?, '{}', ?)").run(id, `__${this.prefix}`, now());
    res.redirect(302, googleSignInUrl(this.d.google, this.redirectUri, id));
  }

  /** Google came back: one-use state, 10 minutes. Returns the verified identity, or null. */
  async finish(req: Request): Promise<{ sub: string; email: string } | null> {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const row = this.d.db.prepare("SELECT created_at FROM pending_auth WHERE id = ? AND client_id = ?").get(state, `__${this.prefix}`) as
      { created_at: number } | undefined;
    this.d.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(state);
    if (!row || row.created_at < now() - 600 || !code) return null;
    const g = await exchangeGoogleCode(this.d.google, code, this.redirectUri, this.d.fetch);
    const c = g.id_token ? idTokenClaims(g.id_token) : null;
    return c?.emailVerified ? { sub: c.sub, email: c.email } : null;
  }

  /** Start a session for `subject` (an email for /admin, a user id for /account). */
  open(res: Response, subject: string): void {
    const token = randomToken();
    this.d.db.prepare("INSERT INTO web_sessions (token_hash, kind, subject, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), this.prefix, subject, now() + this.ttl);
    this.cookie(res, token, this.ttl);
  }

  /** The signed-in subject, or null. */
  subject(req: Request): string | null {
    const t = this.read(req);
    if (!t) return null;
    const row = this.d.db.prepare("SELECT subject, expires_at FROM web_sessions WHERE token_hash = ? AND kind = ?").get(sha256(t), this.prefix) as
      { subject: string; expires_at: number } | undefined;
    return row && row.expires_at > now() ? row.subject : null;
  }

  close(req: Request, res: Response): void {
    const t = this.read(req);
    if (t) this.d.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(t));
    this.cookie(res, "", 0);
  }

  private cookie(res: Response, value: string, maxAge: number): void {
    res.setHeader("Set-Cookie", `${this.cookieName}=${value}; Path=${this.path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`);
  }

  private read(req: Request): string | undefined {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) return decodeURIComponent(v.join("="));
    }
    return undefined;
  }
}
