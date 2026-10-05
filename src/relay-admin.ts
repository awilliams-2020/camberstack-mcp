/**
 * Manage conversion-relay keys (relay.ts) on the box:
 *   node dist/relay-admin.js create <email|auto> <customer_id> <action_id[,action_id…]> <label> [login_customer_id]
 *     auto = the connected user who most recently ran a tool on that account
 *   node dist/relay-admin.js list
 *   node dist/relay-admin.js revoke <label>
 *   node dist/relay-admin.js status            pending / failed / uploaded counts per key, last error
 * The key is printed once and stored only as a hash.
 */
import { openDb, now } from "./db.js";
import { createRelayKey } from "./relay.js";

const db = openDb(process.env.DATA_DIR ?? "/data");
const [cmd, ...a] = process.argv.slice(2);
if (cmd === "create" && (a.length === 4 || a.length === 5)) {
  const [email, cid, actions, label, login] = a as [string, string, string, string, string?];
  console.log(createRelayKey(db, email, cid, actions.split(","), label, login ?? null));
} else if (cmd === "list") {
  console.table(db.prepare(`SELECT k.label, u.email, k.customer_id, k.action_ids, k.login_customer_id, datetime(k.created_at,'unixepoch') created,
    datetime(k.last_used_at,'unixepoch') last_used, k.revoked_at IS NOT NULL revoked FROM relay_keys k JOIN users u ON u.id = k.user_id`).all());
} else if (cmd === "revoke" && a[0]) {
  const r = db.prepare("UPDATE relay_keys SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL").run(now(), a[0]);
  console.log(r.changes ? `revoked ${a[0]}` : `no active key labelled ${a[0]}`);
} else if (cmd === "status") {
  console.table(db.prepare(`SELECT k.label, sum(c.uploaded_at IS NOT NULL) uploaded, sum(c.uploaded_at IS NULL AND c.attempts < 8) pending,
    sum(c.uploaded_at IS NULL AND c.attempts >= 8) gave_up, max(c.error) last_error FROM relay_keys k LEFT JOIN relay_conversions c ON c.key_id = k.id GROUP BY k.id`).all());
} else {
  console.error("usage: relay-admin create <email> <customer_id> <action_ids> <label> [login_customer_id] | list | revoke <label> | status");
  process.exit(2);
}
