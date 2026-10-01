/**
 * Read-only usage report: the funnel the bet is judged on, plus tool usage and failures.
 *   docker exec camberstack node dist/funnel.js [--days 7] [--exclude me@example.com,other@example.com]
 * --exclude drops the operator's own dogfood accounts from every number.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { days: { type: "string", default: "7" }, exclude: { type: "string", default: "" } } });
const days = Number(values.days);
const exclude = values.exclude!.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const db = new Database(join(process.env.DATA_DIR ?? "/data", "camberstack.sqlite"), { readonly: true });
const since = Math.floor(Date.now() / 1000) - days * 86400;

// Real users only; every query below joins through this.
db.exec("CREATE TEMP TABLE u AS SELECT * FROM users");
db.prepare(`DELETE FROM u WHERE lower(email) IN (${exclude.map(() => "?").join(",") || "''"})`).run(...exclude);

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const stage = (window: number) => ({
  connected:   count("SELECT count(*) n FROM u WHERE created_at >= ?", window),
  used_a_tool: count("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1", window),
  diagnosed:   count("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN u ON u.id = c.user_id WHERE u.created_at >= ? AND c.ok = 1 AND c.tool = 'find_wasted_spend'", window),
  proposed:    count("SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN u ON u.id = p.user_id WHERE u.created_at >= ?", window),
  applied:     count("SELECT count(DISTINCT p.user_id) n FROM proposals p JOIN u ON u.id = p.user_id WHERE u.created_at >= ? AND p.status = 'applied'", window),
  paid:        count("SELECT count(*) n FROM u WHERE created_at >= ? AND plan != 'free'", window),
  disconnected: count("SELECT count(*) n FROM u WHERE created_at >= ? AND enc_refresh IS NULL", window),
});

console.log(`# Camberstack usage — ${new Date().toISOString().slice(0, 10)}, window ${days}d${exclude.length ? `, excluding ${exclude.length} account(s)` : ""}\n`);
console.log("## Funnel (users, cohort = connected in window | all time)");
const w = stage(since), all = stage(0);
for (const k of Object.keys(all) as (keyof typeof all)[]) console.log(`  ${k.padEnd(13)} ${String(w[k]).padStart(4)} | ${all[k]}`);
console.log(`  active in window (≥1 ok call): ${count("SELECT count(DISTINCT c.user_id) n FROM tool_calls c JOIN u ON u.id = c.user_id WHERE c.at >= ? AND c.ok = 1", since)}`);

console.log(`\n## Tools, last ${days}d`);
console.table(db.prepare(`SELECT tool, count(*) calls, count(DISTINCT c.user_id) users, sum(ok = 0) errors, cast(avg(ms) AS int) avg_ms, max(ms) max_ms
  FROM tool_calls c JOIN u ON u.id = c.user_id WHERE at >= ? GROUP BY tool ORDER BY calls DESC`).all(since));

console.log(`## MCP clients, last ${days}d (which AI app the calls came from)`);
console.table(db.prepare(`SELECT coalesce(json_extract(cl.info, '$.client_name'), c.client_id, '?') client, count(*) calls, count(DISTINCT c.user_id) users
  FROM tool_calls c JOIN u ON u.id = c.user_id LEFT JOIN clients cl ON cl.client_id = c.client_id WHERE at >= ? GROUP BY 1 ORDER BY calls DESC`).all(since));

console.log(`## Top errors, last ${days}d`);
console.table(db.prepare(`SELECT tool, substr(error, 1, 120) error, count(*) n FROM tool_calls c JOIN u ON u.id = c.user_id
  WHERE at >= ? AND ok = 0 GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`).all(since));
