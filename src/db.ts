import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  enc_refresh   TEXT,            -- AES-GCM(Google refresh token); NULL once disconnected
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- MCP clients registered through dynamic client registration (RFC 7591).
CREATE TABLE IF NOT EXISTS clients (
  client_id   TEXT PRIMARY KEY,
  info        TEXT NOT NULL,     -- OAuthClientInformationFull as JSON
  created_at  INTEGER NOT NULL
);

-- An MCP client's /authorize request, parked while the user is at Google.
CREATE TABLE IF NOT EXISTS pending_auth (
  id          TEXT PRIMARY KEY,  -- also the Google 'state'
  client_id   TEXT NOT NULL,
  params      TEXT NOT NULL,     -- redirectUri, codeChallenge, state, scopes, resource
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  resource    TEXT,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

-- A set of changes the AI proposed. Nothing touches the account until apply.
CREATE TABLE IF NOT EXISTS proposals (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  customer_id        TEXT NOT NULL,
  login_customer_id  TEXT,
  changes            TEXT NOT NULL,   -- Change[] as JSON
  summary            TEXT NOT NULL,   -- human-readable diff shown before approval
  status             TEXT NOT NULL CHECK (status IN ('proposed','applied','failed','discarded')),
  result             TEXT,            -- per-change outcome + inverse ops (for undo)
  undo_of            TEXT,            -- proposal this one reverses
  created_at         INTEGER NOT NULL,
  applied_at         INTEGER
);
CREATE INDEX IF NOT EXISTS proposals_user ON proposals(user_id, created_at);
`;

export function openDb(dataDir: string): DB {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "camberstack.sqlite");
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  enc_refresh: string | null;
  plan: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface ProposalRow {
  id: string;
  user_id: string;
  customer_id: string;
  login_customer_id: string | null;
  changes: string;
  summary: string;
  status: "proposed" | "applied" | "failed" | "discarded";
  result: string | null;
  undo_of: string | null;
  created_at: number;
  applied_at: number | null;
}

/** Drop expired rows. Cheap; run on an interval. */
export function sweep(db: DB): void {
  const t = now();
  db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM pending_auth WHERE created_at < ?").run(t - 3600);
}
