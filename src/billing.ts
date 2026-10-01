/**
 * Pro billing: a Stripe Checkout subscription, no webhook.
 *
 * The user is in a chat, not on our site, so every billing link we hand out is a signed, expiring,
 * per-user URL (the AI shows it; the user clicks it). Paying lands on /upgraded, which verifies the
 * Checkout Session server-side and flips the plan. Two things that page can't see are covered by an
 * hourly sweep against Stripe (same approach as the GEO app's fix-pack orders): a buyer who pays
 * and closes the tab, and a subscription that later ends (cancelled at period end, unpaid).
 * past_due stays Pro while Stripe retries the card.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { DB, UserRow } from "./db.js";
import { now } from "./db.js";

export const PRO_PRICE_LABEL = "$49/month";
const LINK_TTL = 7 * 86400;
const APP = "camberstack-mcp";

export interface BillingDeps {
  db: DB;
  baseUrl: string;
  /** Signs billing links; derived from ENCRYPTION_KEY so no new secret is needed. */
  signingKey: Buffer;
  stripe?: { secretKey: string; proPriceId: string };
  fetch?: typeof fetch;
}

export class Billing {
  constructor(private d: BillingDeps) {}

  get enabled(): boolean { return Boolean(this.d.stripe?.secretKey && this.d.stripe.proPriceId); }

  private sign(payload: string): string {
    return createHmac("sha256", this.d.signingKey).update(`billing:${payload}`).digest("base64url").slice(0, 32);
  }

  /** A link for one user, valid for a week. Null when billing isn't configured. */
  link(kind: "upgrade" | "billing", userId: string): string | null {
    if (!this.enabled) return null;
    const payload = `${userId}.${now() + LINK_TTL}`;
    return `${this.d.baseUrl}/${kind}?t=${payload}.${this.sign(`${kind}:${payload}`)}`;
  }

  verify(kind: "upgrade" | "billing", t: unknown): string | null {
    const [userId, exp, sig] = String(t ?? "").split(".");
    if (!userId || !exp || !sig) return null;
    const want = Buffer.from(this.sign(`${kind}:${userId}.${exp}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got) || Number(exp) < now()) return null;
    return userId;
  }

  private async stripe(path: string, form?: Record<string, string>, method = form ? "POST" : "GET"): Promise<any> {
    const res = await (this.d.fetch ?? fetch)(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.d.stripe!.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Stripe ${path}: ${data?.error?.message ?? res.status}`);
    return data;
  }

  private user(id: string): UserRow | undefined {
    return this.d.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  /** Apply a completed Checkout Session. Idempotent; returns the user it upgraded. */
  private settle(session: any): string | null {
    if (session?.status !== "complete" || session?.metadata?.app !== APP || !session.client_reference_id) return null;
    const r = this.d.db.prepare("UPDATE users SET plan = 'pro', stripe_customer = ?, stripe_sub = ? WHERE id = ?")
      .run(String(session.customer ?? ""), String(session.subscription ?? ""), session.client_reference_id);
    return r.changes ? session.client_reference_id : null;
  }

  /** Hourly: catch payments whose tab was closed, and drop Pro when a subscription has ended. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    const recent = await this.stripe(`checkout/sessions?limit=100&status=complete&created[gte]=${now() - 3 * 86400}`);
    for (const s of recent.data ?? []) {
      const u = s.metadata?.app === APP && s.client_reference_id ? this.user(s.client_reference_id) : undefined;
      if (u && u.stripe_sub !== s.subscription) this.settle(s);
    }
    const pros = this.d.db.prepare("SELECT id, stripe_sub FROM users WHERE plan = 'pro' AND stripe_sub IS NOT NULL AND stripe_sub != ''").all() as
      { id: string; stripe_sub: string }[];
    for (const p of pros) {
      const sub = await this.stripe(`subscriptions/${p.stripe_sub}`);
      if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
        this.d.db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(p.id);
      }
    }
  }

  private portal?: string;
  /** A portal configuration made through the API is not Stripe's default, so name it explicitly. */
  private async portalConfig(): Promise<Record<string, string>> {
    if (!this.portal) {
      const list = await this.stripe("billing_portal/configurations?limit=10&active=true");
      const c = (list.data ?? []).find((x: any) => x.is_default) ?? list.data?.[0];
      if (!c) return {};
      this.portal = c.id as string;
    }
    return { configuration: this.portal };
  }

  mount(app: Express, page: (title: string, body: string) => string): void {
    const send = (res: Response, status: number, title: string, body: string) =>
      res.status(status).setHeader("Cache-Control", "no-store").type("html").send(page(title, body));
    const expired = (res: Response) => send(res, 400, "Link expired",
      `<p>This billing link has expired or is not valid. Ask your AI assistant to run Camberstack's <code>billing</code> tool for a fresh one.</p>`);

    app.get("/upgrade", async (req: Request, res: Response) => {
      const userId = this.verify("upgrade", req.query.t);
      const u = userId ? this.user(userId) : undefined;
      if (!u || !this.enabled) return expired(res);
      if (u.plan === "pro") return send(res, 200, "Already on Pro", `<p>${esc(u.email)} is already on Camberstack Pro. Go back to your AI assistant and carry on.</p>`);
      try {
        const s = await this.stripe("checkout/sessions", {
          mode: "subscription",
          "line_items[0][price]": this.d.stripe!.proPriceId,
          "line_items[0][quantity]": "1",
          client_reference_id: u.id,
          customer_email: u.email,
          allow_promotion_codes: "true",
          "metadata[app]": APP,
          "subscription_data[metadata][user_id]": u.id,
          success_url: `${this.d.baseUrl}/upgraded?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.d.baseUrl}/#pricing`,
        });
        res.redirect(303, s.url);
      } catch (e) {
        send(res, 502, "Checkout unavailable", `<p>Stripe could not start checkout (${esc((e as Error).message)}). Try again in a minute.</p>`);
      }
    });

    app.get("/upgraded", async (req: Request, res: Response) => {
      const id = String(req.query.session_id ?? "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !this.enabled) return expired(res);
      try {
        const ok = this.settle(await this.stripe(`checkout/sessions/${id}`));
        if (!ok) return send(res, 400, "Payment not complete", `<p>We could not confirm this payment. If you were charged, email us and we will sort it out.</p>`);
        send(res, 200, "You're on Pro", `<p><strong>Thanks, you're on Camberstack Pro.</strong></p>
<p>Go back to your AI assistant and ask it to apply the proposal again. Applying changes is now unlimited.</p>
<p><a class="btn" href="/account">Go to your account</a></p>
<p class="muted">Change your card or cancel any time from your account page.</p>`);
      } catch (e) {
        send(res, 502, "Could not confirm", `<p>Stripe did not answer (${esc((e as Error).message)}). Your payment is safe; your plan updates within the hour.</p>`);
      }
    });

    app.get("/billing", async (req: Request, res: Response) => {
      const userId = this.verify("billing", req.query.t);
      const u = userId ? this.user(userId) : undefined;
      if (!u || !this.enabled) return expired(res);
      if (!u.stripe_customer) return send(res, 200, "No subscription", `<p>${esc(u.email)} has no Camberstack subscription.</p>`);
      try {
        const s = await this.stripe("billing_portal/sessions", {
          customer: u.stripe_customer, return_url: `${this.d.baseUrl}/account`, ...(await this.portalConfig()),
        });
        res.redirect(303, s.url);
      } catch (e) {
        send(res, 502, "Billing unavailable", `<p>Stripe's billing page is not available (${esc((e as Error).message)}). Email us to change or cancel your plan.</p>`);
      }
    });
  }
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
