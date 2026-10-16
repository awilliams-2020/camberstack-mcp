/**
 * Manage keyword-relay keys (relay.ts) on the box:
 *   node dist/relay-admin.js create-keywords <email|auto> <customer_id> <label> [login_customer_id]
 *     auto = the connected user who most recently ran a tool on that account
 *   node dist/relay-admin.js list
 *   node dist/relay-admin.js revoke <label>
 * The key is printed once and stored only as a hash. Conversion keys live in ~/conversions-relay now.
 */
import { openDb, now } from "./db.js";
import { createRelayKey } from "./relay.js";

const db = openDb(process.env.DATA_DIR ?? "/data");
const [cmd, ...a] = process.argv.slice(2);
if (cmd === "create-keywords" && (a.length === 3 || a.length === 4)) {
  const [email, cid, label, login] = a as [string, string, string, string?];
  console.log(createRelayKey(db, email, cid, label, login ?? null));
} else if (cmd === "list") {
  console.table(db.prepare(`SELECT k.label, u.email, k.customer_id, k.scopes, k.login_customer_id, datetime(k.created_at,'unixepoch') created,
    datetime(k.last_used_at,'unixepoch') last_used, k.revoked_at IS NOT NULL revoked FROM relay_keys k JOIN users u ON u.id = k.user_id`).all());
} else if (cmd === "revoke" && a[0]) {
  const r = db.prepare("UPDATE relay_keys SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL").run(now(), a[0]);
  console.log(r.changes ? `revoked ${a[0]}` : `no active key labelled ${a[0]}`);
} else {
  console.error("usage: relay-admin create-keywords <email|auto> <customer_id> <label> [login_customer_id] | list | revoke <label>");
  process.exit(2);
}
