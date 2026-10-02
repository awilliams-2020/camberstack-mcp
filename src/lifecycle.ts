/**
 * Two lifecycle emails, each sent at most once per user, through Resend:
 *   first_steps    connected 2–14 days ago and never asked anything real → the first question to ask, and the demo
 *   limit_reached  a tool refused a second Google Ads account (the Free plan's limit), still free 3+ days later → one note: what Pro covers, the upgrade link
 * Never sent to internal accounts (ADMIN_EMAILS, PRO_EMAILS), Pro users, the disconnected, or anyone who unsubscribed.
 *
 * Content stays generic on purpose: counts and links, never campaign names or other Google Ads data
 * (the email address comes from Google sign-in; the account page is where the details live).
 * Unsubscribe: a signed link per user. GET shows a confirm button (mail scanners follow links);
 * POST unsubscribes, which is also what List-Unsubscribe-Post one-click sends (RFC 8058).
 */
import express, { type Express } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { deriveKey, safeEqual, sign } from "./crypto.js";
import { ACCOUNT_WINDOW_DAYS, PLAN_LIMIT_PREFIX, PRO_PRICE_LABEL } from "./plans.js";

export interface MailConfig { apiKey: string; from: string; replyTo: string }

export interface LifecycleDeps {
  db: DB;
  baseUrl: string;
  mail?: MailConfig;
  signingKey: Buffer;
  /** Never emailed: the operator and testers. */
  internalEmails: Set<string>;
  upgradeLink: (userId: string) => string | null;
  fetch?: typeof fetch;
}

/** Key for unsubscribe links; server.ts and email-preview.ts must sign alike. */
export const lifecycleSigningKey = (encryptionKey: Buffer) => deriveKey(encryptionKey, "email-links");

const DAY = 86400;
const USED_TOOLS = "('account_overview','find_wasted_spend','run_gaql','propose_changes')";

export class Lifecycle {
  constructor(private d: LifecycleDeps) {}

  private sig(userId: string): string {
    return sign(this.d.signingKey, `unsubscribe:${userId}`);
  }
  unsubscribeUrl(userId: string): string { return `${this.d.baseUrl}/unsubscribe?u=${userId}&s=${this.sig(userId)}`; }
  private verify(userId: unknown, s: unknown): string | null {
    const u = String(userId ?? "");
    return u && safeEqual(this.sig(u), String(s ?? "")) ? u : null;
  }

  /** Who is due each email right now. */
  private due(): { kind: "first_steps" | "limit_reached"; id: string; email: string; days: number }[] {
    const t = now();
    const eligible = `u.enc_refresh IS NOT NULL AND u.email_opt_out = 0 AND u.plan = 'free'`;
    const notSent = (k: string) => `NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = '${k}')`;
    const first = this.d.db.prepare(`SELECT u.id, u.email, u.created_at FROM users u WHERE ${eligible}
      AND u.created_at BETWEEN ? AND ? AND ${notSent("first_steps")}
      AND NOT EXISTS (SELECT 1 FROM tool_calls c WHERE c.user_id = u.id AND c.ok = 1 AND c.tool IN ${USED_TOOLS})`)
      .all(t - 14 * DAY, t - 2 * DAY) as { id: string; email: string; created_at: number }[];
    // Refused a second account by the plan gate (session.ts checkAccount), the last refusal 3–30 days ago.
    const limit = this.d.db.prepare(`SELECT u.id, u.email, max(c.at) last
      FROM users u JOIN tool_calls c ON c.user_id = u.id AND c.ok = 0 AND c.error LIKE ?
      WHERE ${eligible} AND ${notSent("limit_reached")}
      GROUP BY u.id HAVING last BETWEEN ? AND ?`)
      .all(`${PLAN_LIMIT_PREFIX}%`, t - 30 * DAY, t - 3 * DAY) as { id: string; email: string; last: number }[];
    const ok = (e: string) => !this.d.internalEmails.has(e.toLowerCase());
    return [
      ...first.filter((u) => ok(u.email)).map((u) => ({ kind: "first_steps" as const, id: u.id, email: u.email, days: Math.floor((t - u.created_at) / DAY) })),
      ...limit.filter((u) => ok(u.email)).map((u) => ({ kind: "limit_reached" as const, id: u.id, email: u.email, days: 0 })),
    ];
  }

  /** Hourly. Logs before sending (at most once, even if a send is retried by a crash); a failed send is unlogged to retry. */
  async run(): Promise<number> {
    if (!this.d.mail) return 0;
    let sent = 0;
    for (const u of this.due()) {
      const claim = this.d.db.prepare("INSERT OR IGNORE INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)").run(u.id, u.kind, now());
      if (!claim.changes) continue;
      try {
        await this.send(u.email, u.kind === "first_steps" ? firstSteps(u.days) : limitReached(this.d.baseUrl, this.d.upgradeLink(u.id)), u.id);
        sent++;
      } catch (e) {
        this.d.db.prepare("DELETE FROM email_log WHERE user_id = ? AND kind = ?").run(u.id, u.kind);
        console.error(`lifecycle ${u.kind}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async send(to: string, m: { subject: string; text: string; html: string }, userId: string): Promise<void> {
    const unsub = this.unsubscribeUrl(userId);
    const footer = `You're getting this because you connected Camberstack (camberstack.io) to Google Ads.`;
    const res = await (this.d.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.d.mail!.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.d.mail!.from, to: [to], reply_to: this.d.mail!.replyTo, subject: m.subject,
        text: `${m.text}\n\n--\n${footer}\nUnsubscribe: ${unsub}`,
        html: `${m.html}<hr style="border:0;border-top:1px solid #ddd;margin:28px 0 12px">
<p style="color:#777;font-size:13px">${footer} <a href="${unsub}" style="color:#777">Unsubscribe</a></p>`,
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** Operator check: send one sample of each email to `to`, with placeholder links. */
  async preview(to: string): Promise<void> {
    await this.send(to, firstSteps(3), "preview");
    await this.send(to, limitReached(this.d.baseUrl, `${this.d.baseUrl}/account?upgrade=1`), "preview");
  }

  mount(app: Express, page: (title: string, body: string) => string): void {
    const optOut = (u: string) => this.d.db.prepare("UPDATE users SET email_opt_out = 1 WHERE id = ?").run(u);
    app.get("/unsubscribe", (req, res) => {
      const u = this.verify(req.query.u, req.query.s);
      res.setHeader("Cache-Control", "no-store");
      if (!u) { res.status(400).type("html").send(page("Link not valid", "<p>This unsubscribe link isn't valid. Reply to any of our emails and we'll take you off.</p>")); return; }
      res.type("html").send(page("Unsubscribe", `<p>Stop getting Camberstack emails? You'll still be able to use Camberstack as normal.</p>
<form method="post" action="/unsubscribe?u=${u}&s=${this.sig(u)}"><button class="btn" style="border:0;cursor:pointer">Unsubscribe</button></form>`));
    });
    app.post("/unsubscribe", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
      const u = this.verify(req.query.u, req.query.s);
      if (!u) { res.status(400).end(); return; }
      optOut(u);
      res.type("html").send(page("Unsubscribed", "<p>Done. You won't get any more emails from Camberstack.</p>"));
    });
  }
}

// ---------------------------------------------------------------- the two emails

const p = (s: string) => `<p style="margin:0 0 14px">${s}</p>`;
const wrap = (body: string) => `<div style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19;max-width:560px">${body}</div>`;

function firstSteps(days: number) {
  const ask = "What's wasting money in my Google Ads account over the last 90 days?";
  return {
    subject: "The first thing to ask Camberstack",
    text: `Hi,

You connected Camberstack to Google Ads ${days} days ago but haven't asked it anything yet. The best first question, in Claude or ChatGPT:

  "${ask}"

It checks your conversion tracking first, then shows the search terms, keywords and campaigns that spend without converting, and suggests fixes. Nothing changes until you approve.

Rather try it on sample data first? Ask: "Show me Camberstack's demo account."

If something didn't work when you tried, just reply. I read every email.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`You connected Camberstack to Google Ads ${days} days ago but haven't asked it anything yet. The best first question, in Claude or ChatGPT:`)
      + `<p style="margin:0 0 14px;padding:12px 14px;background:#f1eee7;border-radius:8px"><strong>“${ask}”</strong></p>`
      + p("It checks your conversion tracking first, then shows the search terms, keywords and campaigns that spend without converting, and suggests fixes. Nothing changes until you approve.")
      + p(`Rather try it on sample data first? Ask: <em>“Show me Camberstack's demo account.”</em>`)
      + p("If something didn't work when you tried, just reply. I read every email.") + p("Adam<br>Camberstack")),
  };
}

function limitReached(base: string, upgrade: string | null) {
  return {
    subject: "Using Camberstack on more than one Google Ads account",
    text: `Hi,

Camberstack stopped when you tried it on a second Google Ads account. The Free plan covers one account at a time (an account
drops out ${ACCOUNT_WINDOW_DAYS} days after you last used it), with every tool and unlimited changes. Undo and history always work: ${base}/account

Camberstack Pro covers up to 10 accounts, for ${PRO_PRICE_LABEL}, cancel any time${upgrade ? `:\n${upgrade}\n(personal link, valid for 7 days)` : ` from ${base}/account`}.

This is the only email about it. Questions? Just reply.

Adam
Camberstack`,
    html: wrap(p("Hi,") + p(`Camberstack stopped when you tried it on a second Google Ads account. The Free plan covers one account at a time (an account drops out ${ACCOUNT_WINDOW_DAYS} days after you last used it), with every tool and unlimited changes. Undo and history always work, on <a href="${base}/account">your account page</a>.`)
      + p(`Camberstack Pro covers up to 10 accounts, for ${PRO_PRICE_LABEL}, cancel any time.`)
      + `<p style="margin:0 0 18px"><a href="${upgrade ?? `${base}/account?upgrade=1`}" style="display:inline-block;background:#1f5f4a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Upgrade to Pro</a></p>`
      + p("This is the only email about it. Questions? Just reply.") + p("Adam<br>Camberstack")),
  };
}
