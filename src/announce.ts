/**
 * Announcements: emails the operator writes in the admin (admin.ts) and sends to users, e.g. "Google Analytics is
 * now open to everyone". The users table is the subscriber list, so there's one list and one opt-out: nobody who
 * unsubscribed (email_opt_out) and no internal account (ADMIN_EMAILS, PRO_EMAILS) ever gets one.
 *
 *   draft    written and previewed; a test goes to the operator only
 *   sending  the every-minute job sends to whoever in the audience hasn't had it, at Resend's pace
 *   sent     nobody left
 *
 * Each recipient is claimed in email_log (kind "announce:<id>") before the send, as lifecycle.ts does, and Resend's
 * idempotency key covers a retry, so a restart or the two blue/green colors mid-deploy can't send anyone twice.
 */
import { randomBytes } from "node:crypto";
import type { DB } from "./db.js";
import { now } from "./db.js";
import type { Lifecycle } from "./lifecycle.js";
import { esc } from "./pages.js";

export type Audience = "all" | "free" | "pro";
export const AUDIENCES: Record<Audience, string> = { all: "Everyone", free: "Free plan", pro: "Pro plan" };

export interface Announcement {
  id: string; subject: string; body: string; audience: Audience; status: "draft" | "sending" | "sent";
  created_by: string; created_at: number; started_at: number | null; sent_at: number | null;
}

/** Resend allows 2 requests a second by default; stay under it. */
const GAP_MS = 600;

export interface AnnounceDeps {
  db: DB;
  lifecycle: Lifecycle;
  internalEmails: Set<string>;
  /** False when Resend isn't configured: nothing can be sent. */
  canSend: boolean;
  /** Set (MAIL_POSTAL_ADDRESS): announcements are marketing mail, so sending to users waits for an address. */
  postalAddress?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class Announcements {
  private running = false;
  constructor(private d: AnnounceDeps) {}

  list(): (Announcement & { sent: number })[] {
    return this.d.db.prepare(`SELECT a.*, (SELECT count(*) FROM email_log e WHERE e.kind = 'announce:' || a.id) sent
      FROM announcements a ORDER BY a.created_at DESC`).all() as (Announcement & { sent: number })[];
  }

  get(id: string): Announcement | undefined {
    return this.d.db.prepare("SELECT * FROM announcements WHERE id = ?").get(id) as Announcement | undefined;
  }

  create(o: { subject: string; body: string; audience: Audience; by: string }): string {
    const id = `a_${randomBytes(4).toString("hex")}`;
    this.d.db.prepare("INSERT INTO announcements (id, subject, body, audience, status, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)")
      .run(id, clean(o.subject, 150), clean(o.body, 20_000), o.audience, o.by, now());
    return id;
  }

  /** Drafts only: once sending starts, what was sent is what's on record. */
  update(id: string, o: { subject: string; body: string; audience: Audience }): boolean {
    return this.d.db.prepare("UPDATE announcements SET subject = ?, body = ?, audience = ? WHERE id = ? AND status = 'draft'")
      .run(clean(o.subject, 150), clean(o.body, 20_000), o.audience, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.d.db.prepare("DELETE FROM announcements WHERE id = ? AND status = 'draft'").run(id).changes > 0;
  }

  /** Who would get it right now (or still will, while sending): the audience minus opt-outs, internal accounts and anyone already sent it. */
  recipients(a: Pick<Announcement, "id" | "audience">): { id: string; email: string; plan: string }[] {
    const plan = a.audience === "free" ? "AND u.plan = 'free'" : a.audience === "pro" ? "AND u.plan != 'free'" : "";
    return (this.d.db.prepare(`SELECT u.id, u.email, u.plan FROM users u WHERE u.email_opt_out = 0 ${plan}
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = ?) ORDER BY u.created_at`)
      .all(`announce:${a.id}`) as { id: string; email: string; plan: string }[])
      .filter((u) => !this.d.internalEmails.has(u.email.toLowerCase()));
  }

  /** Why it can't go to users yet, or null when it can. */
  blocker(): string | null {
    if (!this.d.canSend) return "Email isn't configured (RESEND_API_KEY).";
    if (!this.d.postalAddress) return "Set MAIL_POSTAL_ADDRESS in .env first: announcements are marketing email, which needs a postal address in the footer.";
    return null;
  }

  /** A copy to the operator, nothing logged. Works without a postal address, so the draft can be checked first. */
  async sendTest(id: string, to: string): Promise<void> {
    const a = this.get(id);
    if (!a) throw new Error("No such announcement.");
    if (!this.d.canSend) throw new Error("Email isn't configured (RESEND_API_KEY).");
    await this.d.lifecycle.sendAnnouncement(to, render(a, true), "preview");
  }

  /** draft → sending. The job does the sending. */
  start(id: string): boolean {
    if (this.blocker()) return false;
    return this.d.db.prepare("UPDATE announcements SET status = 'sending', started_at = ? WHERE id = ? AND status = 'draft'").run(now(), id).changes > 0;
  }

  /** Every minute, and right after start: send what's due. One run at a time per process. */
  async process(): Promise<number> {
    if (this.running || this.blocker()) return 0;
    this.running = true;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let sent = 0;
    try {
      for (const a of this.d.db.prepare("SELECT * FROM announcements WHERE status = 'sending' ORDER BY started_at").all() as Announcement[]) {
        const m = render(a, false);
        for (const u of this.recipients(a)) {
          const kind = `announce:${a.id}`;
          if (!this.d.db.prepare("INSERT OR IGNORE INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)").run(u.id, kind, now()).changes) continue;
          try {
            await this.d.lifecycle.sendAnnouncement(u.email, m, u.id, `${u.id}:${kind}`);
            sent++;
          } catch (e) {
            // Unclaim to retry next run; stop this announcement for now (Resend down or rate-limited).
            this.d.db.prepare("DELETE FROM email_log WHERE user_id = ? AND kind = ?").run(u.id, kind);
            console.error(`announcement ${a.id}: ${(e as Error).message}`);
            break;
          }
          await sleep(GAP_MS);
        }
        if (!this.recipients(a).length) this.d.db.prepare("UPDATE announcements SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'sending'").run(now(), a.id);
      }
    } finally {
      this.running = false;
    }
    return sent;
  }
}

const clean = (s: string, max: number) => s.replace(/\r\n/g, "\n").trim().slice(0, max);

/**
 * Subject + body as an email. The body is plain text with a little markup: blank lines between paragraphs,
 * lines starting "- " are bullets, **bold**, [text](https://…) links, and bare https:// URLs link themselves.
 */
export function render(a: Pick<Announcement, "subject" | "body">, test: boolean): { subject: string; text: string; html: string } {
  const inline = (s: string) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    // A sentence's closing punctuation isn't part of the URL.
    .replace(/(^|[\s(])(https:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, (_m, pre: string, u: string) => `${pre}<a href="${u}">${u}</a>`);
  const blocks = a.body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const html = blocks.map((b) => {
    const lines = b.split("\n");
    return lines.every((l) => l.startsWith("- "))
      ? `<ul style="margin:0 0 14px;padding-left:22px">${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`
      : `<p style="margin:0 0 14px">${lines.map(inline).join("<br>")}</p>`;
  }).join("");
  const text = a.body.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, "$1 ($2)");
  return {
    subject: `${test ? "[TEST] " : ""}${a.subject}`,
    text,
    html: `<div style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19;max-width:560px">${html}</div>`,
  };
}
