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

-- One row per MCP tool call: usage + failures. Metadata only, never arguments or Ads data
-- (the privacy page promises the Google data goes nowhere else).
CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  client_id    TEXT,            -- which registered MCP client (clients.info has its client_name)
  tool         TEXT NOT NULL,
  customer_id  TEXT,
  ok           INTEGER NOT NULL,
  error        TEXT,            -- first 300 chars of the message shown to the AI
  ms           INTEGER NOT NULL,
  bytes        INTEGER NOT NULL -- size of the result text
);
CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls(at);

-- Browser sign-ins to our own pages (signin.ts): kind = the page's state prefix, subject = an email
-- (/admin) or a user id (/account). Tokens stored as hashes.
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
DROP TABLE IF EXISTS admin_sessions;  -- replaced by web_sessions 2026-10-01

-- Our own ad campaign's conversions (adconversions.ts): one per user, on their first connection.
CREATE TABLE IF NOT EXISTS ad_conversions (
  user_id      TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('gclid','gbraid','wbraid')),
  click_id     TEXT NOT NULL,
  at           INTEGER NOT NULL,
  uploaded_at  INTEGER,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);

-- Lifecycle emails (lifecycle.ts): one row per user per kind, so each is sent at most once.
CREATE TABLE IF NOT EXISTS email_log (
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- Each user's copy of the demo account (demo.ts): only what their changes altered, as JSON.
CREATE TABLE IF NOT EXISTS demo_state (
  user_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
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
  // Columns added after launch; CREATE TABLE IF NOT EXISTS won't add them to an existing table.
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("stripe_customer")) db.exec("ALTER TABLE users ADD COLUMN stripe_customer TEXT");
  if (!cols.has("stripe_sub")) db.exec("ALTER TABLE users ADD COLUMN stripe_sub TEXT");
  if (!cols.has("email_opt_out")) db.exec("ALTER TABLE users ADD COLUMN email_opt_out INTEGER NOT NULL DEFAULT 0");
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
  stripe_customer?: string | null;
  stripe_sub?: string | null;
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
  db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(t);
}
