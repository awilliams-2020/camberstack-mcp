/**
 * Usage report over our own SQLite: the funnel the bet is judged on, per-user state, tool usage and
 * failures. Read-only. Shared by the CLI (funnel.ts) and the admin page (admin.ts) so the two can't
 * disagree about a number.
 */
import type { DB } from "./db.js";
import { DEMO_CID } from "./demo.js";
import { now } from "./db.js";

export interface ReportOptions {
  days: number;
  /** Emails left out of every number (the operator's and testers' own accounts). */
  exclude: string[];
}

export function buildReport(db: DB, o: ReportOptions) {
  const since = now() - o.days * 86400;
  const ex = o.exclude.map((e) => e.toLowerCase());
  // Every query joins through `u`, so the exclusion applies everywhere at once.
  const U = `(SELECT * FROM users WHERE lower(email) NOT IN (${ex.map(() => "?").join(",") || "''"}))`;
  const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql.replaceAll("{U}", U)).all(...bind(sql, ex, p)) as T[];
  const n = (sql: string, ...p: unknown[]) => (q<{ n: number }>(sql, ...p)[0]?.n ?? 0);

  const stage = (from: number) => ({
    connected:    n("SELECT count(*) n FROM {U} u WHERE created_at >= ?", from),
    used_a_tool:  n("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1", from),
    // Demo activity is its own stage; every stage after it counts real accounts only.
    tried_demo:   n(`SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1 AND c.customer_id = '${DEMO_CID}'`, from),
    diagnosed:    n(`SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1 AND c.tool = 'find_wasted_spend' AND c.customer_id != '${DEMO_CID}'`, from),
    proposed:     n(`SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN {U} u ON u.id = p.user_id WHERE u.created_at >= ? AND p.customer_id != '${DEMO_CID}'`, from),
    applied:      n(`SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN {U} u ON u.id = p.user_id WHERE u.created_at >= ? AND p.status = 'applied' AND p.customer_id != '${DEMO_CID}'`, from),
    paid:         n("SELECT count(*) n FROM {U} u WHERE created_at >= ? AND plan != 'free'", from),
    disconnected: n("SELECT count(*) n FROM {U} u WHERE created_at >= ? AND enc_refresh IS NULL", from),
  });

  const client = "coalesce(json_extract(cl.info, '$.client_name'), c.client_id, 'unknown')";
  return {
    days: o.days,
    excluded: ex.length,
    funnel: { window: stage(since), all: stage(0) },
    activeInWindow: n("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 1", since),
    users: q<{ email: string; plan: string; created_at: number; last_seen_at: number | null; connected: number;
               calls: number; errors: number; applied: number; client: string | null }>(
      `SELECT u.email, u.plan, u.created_at, u.last_seen_at, u.enc_refresh IS NOT NULL connected,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id) calls,
         (SELECT count(*) FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 0) errors,
         (SELECT count(*) FROM proposals p WHERE p.user_id = u.id AND p.status = 'applied') applied,
         (SELECT ${client} FROM tool_calls c LEFT JOIN clients cl ON cl.client_id = c.client_id
            WHERE c.user_id = u.id ORDER BY c.at DESC LIMIT 1) client
       FROM {U} u ORDER BY coalesce(u.last_seen_at, u.created_at) DESC LIMIT 200`),
    tools: q<{ tool: string; calls: number; users: number; errors: number; avg_ms: number; max_ms: number }>(
      `SELECT tool, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors, cast(avg(ms) AS int) avg_ms, max(ms) max_ms
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE at >= ? GROUP BY tool ORDER BY calls DESC`, since),
    clients: q<{ client: string; calls: number; users: number }>(
      `SELECT ${client} client, count(*) calls, count(DISTINCT c.user_id) users
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       WHERE at >= ? GROUP BY 1 ORDER BY calls DESC`, since),
    errors: q<{ tool: string; error: string; n: number; last: number }>(
      `SELECT tool, substr(error, 1, 160) error, count(*) n, max(at) last FROM tool_calls c JOIN {U} u ON u.id = c.user_id
       WHERE at >= ? AND ok = 0 GROUP BY 1, 2 ORDER BY n DESC LIMIT 15`, since),
    daily: q<{ day: string; calls: number; users: number; errors: number }>(
      `SELECT date(at, 'unixepoch') day, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id WHERE at >= ? GROUP BY 1 ORDER BY 1`, since),
    emails: q<{ kind: string; sent: number; in_window: number }>(
      `SELECT e.kind, count(*) sent, sum(e.sent_at >= ?) in_window FROM email_log e JOIN {U} u ON u.id = e.user_id GROUP BY 1 ORDER BY 1`, since),
    adConversions: q<{ recorded: number; uploaded: number; failing: number; last_error: string | null }>(
      `SELECT count(*) recorded, count(a.uploaded_at) uploaded, sum(a.uploaded_at IS NULL AND a.error IS NOT NULL) failing,
         (SELECT error FROM ad_conversions WHERE error IS NOT NULL ORDER BY at DESC LIMIT 1) last_error
       FROM ad_conversions a JOIN {U} u ON u.id = a.user_id`)[0],
    recent: q<{ at: number; email: string; tool: string; customer_id: string | null; ok: number; error: string | null; ms: number; client: string }>(
      `SELECT c.at, u.email, c.tool, c.customer_id, c.ok, substr(c.error, 1, 160) error, c.ms, ${client} client
       FROM tool_calls c JOIN {U} u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id
       ORDER BY c.id DESC LIMIT 50`),
  };
}

export type Report = ReturnType<typeof buildReport>;

/** {U} expands to a subquery with one placeholder per excluded email; bind those in order. No literal "?" in the SQL. */
function bind(sql: string, ex: string[], params: unknown[]): unknown[] {
  const out: unknown[] = [];
  let pi = 0;
  for (const m of sql.matchAll(/\{U\}|\?/g)) out.push(...(m[0] === "{U}" ? ex : [params[pi++]]));
  return out;
}
