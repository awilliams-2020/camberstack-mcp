/**
 * Conversion relay: lets the operator's own apps (redbudway, theqrcode) report ad-click conversions
 * without holding a Google Ads token of their own.
 *
 *   POST /v1/conversions   Authorization: Bearer csk_…
 *   { "conversion_action_id": "7585493163", "gclid": "…", "conversion_time": "2026-10-04T21:00:00Z", "value": 0 }
 *
 * A key belongs to one Camberstack user and one Google Ads account. Conversions are queued, then
 * uploaded with THAT user's stored Google connection (the same one their AI app uses, which doesn't
 * expire the way a self-minted script token does). Failures stay queued and the hourly sweep retries
 * them, like our own ad's conversions (adconversions.ts).
 *
 * Keys are created on the box, never over HTTP, and each is limited to the conversion actions named
 * at creation, so a leaked key can only add conversions to those actions in that one account:
 *   docker exec camberstack node dist/relay-admin.js create <email> <customer_id> <action_ids> <label> [login_customer_id]
 * This is for the operator's own apps; it is not offered to Camberstack users.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { now, type DB, type UserRow } from "./db.js";
import { AdsClient } from "./google.js";
import { UserSession, type SessionDeps } from "./session.js";

const MAX_ATTEMPTS = 8;
/** Google accepts click conversions up to 90 days after the click. */
const MAX_AGE_DAYS = 90;

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

const Body = z.object({
  conversion_action_id: z.string().regex(/^\d+$/),
  gclid: z.string().regex(/^[A-Za-z0-9_\-.~]{10,300}$/).optional(),
  gbraid: z.string().regex(/^[A-Za-z0-9_\-.~]{10,300}$/).optional(),
  wbraid: z.string().regex(/^[A-Za-z0-9_\-.~]{10,300}$/).optional(),
  conversion_time: z.string().datetime({ offset: true }).optional(),
  value: z.number().min(0).max(1_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).refine((b) => [b.gclid, b.gbraid, b.wbraid].filter(Boolean).length === 1, "exactly one of gclid, gbraid, wbraid");

interface KeyRow { id: string; user_id: string; customer_id: string; login_customer_id: string | null; label: string; action_ids: string }

export function createRelayKey(db: DB, email: string, customerId: string, actionIds: string[], label: string, loginCustomerId: string | null = null): string {
  if (!actionIds.length || actionIds.some((x) => !/^\d+$/.test(x))) throw new Error("action ids must be digits, e.g. 7585493163");
  const user = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
  if (!user) throw new Error(`No Camberstack user ${email}; connect Camberstack with that Google login first.`);
  const key = `csk_${randomBytes(32).toString("base64url")}`;
  db.prepare(`INSERT INTO relay_keys (id, key_hash, user_id, customer_id, login_customer_id, label, action_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), hash(key), user.id, customerId.replace(/-/g, ""), loginCustomerId?.replace(/-/g, "") || null, label, actionIds.join(","), now());
  return key;
}

export class Relay {
  constructor(private deps: SessionDeps, private f: typeof fetch = fetch) {}

  /** The HTTP handler. 202 = queued (and an upload attempt started); duplicates are accepted silently. */
  handle = (req: Request, res: Response): void => {
    const key = /^Bearer (csk_[A-Za-z0-9_-]{20,})$/.exec(req.get("authorization") ?? "")?.[1];
    const k = key && this.deps.db.prepare("SELECT * FROM relay_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(key)) as KeyRow | undefined;
    if (!k) { res.status(401).json({ error: "invalid or revoked key" }); return; }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }); return; }
    const b = parsed.data;
    if (!k.action_ids.split(",").includes(b.conversion_action_id)) {
      res.status(403).json({ error: `this key may only report conversion action(s) ${k.action_ids}` }); return;
    }
    const at = b.conversion_time ? Math.floor(Date.parse(b.conversion_time) / 1000) : now();
    if (at > now() + 300 || at < now() - MAX_AGE_DAYS * 86400) { res.status(400).json({ error: `conversion_time must be within the last ${MAX_AGE_DAYS} days` }); return; }
    const kind = b.gclid ? "gclid" : b.gbraid ? "gbraid" : "wbraid";
    this.deps.db.prepare(`INSERT OR IGNORE INTO relay_conversions (key_id, action_id, kind, click_id, at, value, currency) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(k.id, b.conversion_action_id, kind, b[kind]!, at, b.value ?? null, b.currency ?? null);
    this.deps.db.prepare("UPDATE relay_keys SET last_used_at = ? WHERE id = ?").run(now(), k.id);
    res.status(202).json({ queued: true });
    void this.flush().catch(() => { /* retried by the sweep */ });
  };

  private flushing = false;

  /** Upload every pending conversion, grouped by key (one user + account per key). */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const rows = this.deps.db.prepare(`SELECT c.*, k.user_id, k.customer_id, k.login_customer_id FROM relay_conversions c
          JOIN relay_keys k ON k.id = c.key_id WHERE c.uploaded_at IS NULL AND c.attempts < ? AND k.revoked_at IS NULL ORDER BY c.id`)
        .all(MAX_ATTEMPTS) as (KeyRow & { id: number; key_id: string; action_id: string; kind: string; click_id: string; at: number; value: number | null; currency: string | null })[];
      const byKey = new Map<string, typeof rows>();
      for (const r of rows) byKey.set(r.key_id, [...(byKey.get(r.key_id) ?? []), r]);
      for (const batch of byKey.values()) {
        const first = batch[0]!;
        const fail = (msg: string, ids = batch.map((r) => r.id)) => {
          const st = this.deps.db.prepare("UPDATE relay_conversions SET error = ?, attempts = attempts + 1 WHERE id = ?");
          for (const id of ids) st.run(msg.slice(0, 500), id);
        };
        const user = this.deps.db.prepare("SELECT * FROM users WHERE id = ?").get(first.user_id) as UserRow | undefined;
        if (!user?.enc_refresh) { fail("key owner is not connected to Google; reconnect Camberstack"); continue; }
        const session = new UserSession(this.deps, user);
        const ads = this.deps.adsFactory?.(user) ?? new AdsClient(() => session.googleAccessToken(), this.deps.google.developerToken, this.f);
        try {
          const errors = await ads.uploadClickConversions(first.customer_id, batch.map((r) => ({
            [r.kind]: r.click_id,
            conversionAction: `customers/${first.customer_id}/conversionActions/${r.action_id}`,
            // Google's required format: "yyyy-MM-dd HH:mm:ss+00:00".
            conversionDateTime: new Date(r.at * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00:00"),
            ...(r.value != null ? { conversionValue: r.value, currencyCode: r.currency ?? "USD" } : {}),
          })), first.login_customer_id);
          const ok = this.deps.db.prepare("UPDATE relay_conversions SET uploaded_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?");
          batch.forEach((r, i) => (errors[i] ? fail(`rejected: ${errors[i]}`, [r.id]) : ok.run(now(), r.id)));
        } catch (e) {
          fail((e as Error).message);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
