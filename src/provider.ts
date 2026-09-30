/**
 * The OAuth 2.1 authorization server that MCP clients (Claude, ChatGPT, Cursor…) talk to.
 *
 * The flow chains two consents:
 *   MCP client ──/authorize──▶ us ──redirect──▶ Google consent (adwords + email)
 *   Google ──/oauth/google/callback──▶ us: store the Google refresh token (encrypted),
 *   issue OUR authorization code ──▶ MCP client ──/token──▶ OUR access + refresh tokens.
 *
 * The MCP client never sees a Google token. Our tokens are random and stored only as hashes.
 */
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomUUID } from "node:crypto";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";
import { encrypt, randomToken, sha256 } from "./crypto.js";
import {
  ADS_SCOPE, exchangeGoogleCode, googleAuthUrl, idTokenClaims, type GoogleCreds,
} from "./google.js";

export const MCP_SCOPE = "ads";
const ACCESS_TTL = 3600;              // 1 hour
const REFRESH_TTL = 90 * 24 * 3600;   // 90 days, rotated on every use
const CODE_TTL = 600;                 // 10 minutes

interface PendingParams {
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

export class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private db: DB) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as
      { info: string } | undefined;
    return row ? JSON.parse(row.info) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: now(),
    };
    this.db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, ?)")
      .run(full.client_id, JSON.stringify(full), now());
    return full;
  }
}

export class CamberstackProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;

  constructor(
    private db: DB,
    private opts: { baseUrl: string; google: GoogleCreds; encryptionKey: Buffer; fetch?: typeof fetch },
  ) {
    this.clientsStore = new ClientsStore(db);
  }

  get googleRedirectUri(): string {
    return `${this.opts.baseUrl}/oauth/google/callback`;
  }

  /** Step 1: park the MCP client's request and send the user to Google. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.opts.google.clientId) {
      const back = new URL(params.redirectUri);
      if (params.state) back.searchParams.set("state", params.state);
      back.searchParams.set("error", "temporarily_unavailable");
      back.searchParams.set("error_description", "Camberstack sign-in is not open yet. See https://camberstack.io");
      res.redirect(302, back.toString());
      return;
    }
    const id = randomToken(24);
    const p: PendingParams = {
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [MCP_SCOPE],
      resource: params.resource?.href,
    };
    this.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, ?, ?, ?)")
      .run(id, client.client_id, JSON.stringify(p), now());
    res.redirect(302, googleAuthUrl(this.opts.google, this.googleRedirectUri, id));
  }

  /**
   * Step 2: Google sent the user back. Returns the URL to redirect the browser to — the MCP
   * client's redirect_uri carrying either our code or an OAuth error.
   */
  async completeGoogleCallback(q: { code?: string; state?: string; error?: string }): Promise<string> {
    const pending = q.state
      ? (this.db.prepare("SELECT * FROM pending_auth WHERE id = ?").get(q.state) as
          { id: string; client_id: string; params: string; created_at: number } | undefined)
      : undefined;
    if (!pending || pending.created_at < now() - 3600) {
      throw new Error("This sign-in link has expired. Start the connection again from your AI app.");
    }
    this.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(pending.id);
    const p = JSON.parse(pending.params) as PendingParams;
    const back = new URL(p.redirectUri);
    if (p.state) back.searchParams.set("state", p.state);

    if (q.error || !q.code) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "Google access was not granted.");
      return back.toString();
    }

    const g = await exchangeGoogleCode(this.opts.google, q.code, this.googleRedirectUri, this.opts.fetch);
    if (!g.scope.split(" ").includes(ADS_SCOPE)) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "Google Ads access was not granted (the Google Ads box was unticked).");
      return back.toString();
    }
    if (!g.id_token) throw new Error("Google did not return an id_token");
    const { sub, email } = idTokenClaims(g.id_token);
    const user = this.upsertUser(sub, email, g.refresh_token);

    const code = randomToken();
    this.db.prepare(`INSERT INTO auth_codes
        (code_hash, client_id, user_id, code_challenge, redirect_uri, resource, scopes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(code), pending.client_id, user.id, p.codeChallenge, p.redirectUri,
        p.resource ?? null, p.scopes.join(" "), now() + CODE_TTL);
    back.searchParams.set("code", code);
    return back.toString();
  }

  private upsertUser(sub: string, email: string, refreshToken?: string): UserRow {
    const existing = this.db.prepare("SELECT * FROM users WHERE google_sub = ?").get(sub) as UserRow | undefined;
    const enc = refreshToken ? encrypt(this.opts.encryptionKey, refreshToken) : null;
    if (existing) {
      this.db.prepare("UPDATE users SET email = ?, enc_refresh = COALESCE(?, enc_refresh), last_seen_at = ? WHERE id = ?")
        .run(email, enc, now(), existing.id);
      return { ...existing, email, enc_refresh: enc ?? existing.enc_refresh };
    }
    if (!enc) throw new Error("Google did not return a refresh token; remove Camberstack at myaccount.google.com/permissions and connect again.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO users (id, google_sub, email, enc_refresh, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sub, email, enc, now(), now());
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.codeRow(client, code);
    return row.code_challenge;
  }

  private codeRow(client: OAuthClientInformationFull, code: string) {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(sha256(code)) as
      { client_id: string; user_id: string; code_challenge: string; redirect_uri: string;
        resource: string | null; scopes: string; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.codeRow(client, code);
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource mismatch");
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
    return this.issue(client.client_id, row.user_id, row.scopes.split(" "), row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(sha256(refreshToken)) as
      { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const user = this.db.prepare("SELECT enc_refresh FROM users WHERE id = ?").get(row.user_id) as
      { enc_refresh: string | null } | undefined;
    if (!user?.enc_refresh) throw new InvalidGrantError("Google Ads is disconnected; connect again");
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(refreshToken)); // rotate
    const granted = row.scopes.split(" ");
    const want = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.issue(client.client_id, row.user_id, want, resource?.href ?? row.resource);
  }

  private issue(clientId: string, userId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    const ins = this.db.prepare(`INSERT INTO tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run(sha256(access), "access", clientId, userId, scopes.join(" "), resource, now() + ACCESS_TTL);
    ins.run(sha256(refresh), "refresh", clientId, userId, scopes.join(" "), resource, now() + REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token)) as
      { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number } | undefined;
    if (!row || row.expires_at < now()) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(" ").filter(Boolean),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ? AND client_id = ?").run(sha256(req.token), client.client_id);
  }
}
