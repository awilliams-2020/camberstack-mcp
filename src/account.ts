/**
 * /account: a connected user's own page, for what they'd otherwise have to ask their AI for: plan and
 * free applies left, upgrade or manage billing, every change Camberstack made, and disconnect.
 * Google sign-in (signin.ts, identity only) matched to the user who connected through an AI app.
 */
import express, { type Express, type Request } from "express";
import type { DB, UserRow } from "./db.js";
import type { GoogleCreds } from "./google.js";
import type { UserSession } from "./session.js";
import { SignIn } from "./signin.js";
import { appPage, COPY_JS, esc, infoPage } from "./pages.js";
import { DEMO_CID } from "./demo.js";
import { ACCOUNT_WINDOW_DAYS, PRO_PRICE_LABEL } from "./plans.js";

export interface AccountDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  fetch?: typeof fetch;
  session: (userId: string) => UserSession;
  billingLink: (kind: "upgrade" | "billing", userId: string) => string | null;
}

/** "Oct 1, 19:44 UTC" */
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
/** Google's dashed form: 386-283-8095 */
const fmtCid = (c: string) => c === DEMO_CID ? "000-000-0001 (demo, sample data)" : /^\d{10}$/.test(c) ? `${c.slice(0, 3)}-${c.slice(3, 6)}-${c.slice(6)}` : c;

export function mountAccount(app: Express, d: AccountDeps): SignIn {
  const auth = new SignIn(d, "acc_", "cs_account", "/account", 7 * 86400);
  const user = (req: Request): UserRow | undefined => {
    const id = auth.subject(req);
    return id ? d.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined : undefined;
  };
  const page = (title: string, body: string) => infoPage(d.baseUrl, title, body);
  const shell = (title: string, body: string) => appPage(d.baseUrl, title, "/account", body);

  app.use("/account", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/account/login", (req, res) => {
    if (!d.google.clientId) { res.status(503).type("html").send(page("Sign-in unavailable", "<p>Google sign-in is not configured.</p>")); return; }
    // Only a sign-in started from the upgrade screen continues to checkout.
    auth.start(res, req.query.next === "upgrade" ? "/account?upgrade=1" : undefined);
  });

  app.get("/account/callback", async (req, res) => {
    const who = await auth.finish(req);
    if (!who) { res.status(400).type("html").send(page("Sign-in didn't finish", `<p>The sign-in expired or was cancelled. <a href="/account/login">Try again</a>.</p>`)); return; }
    const u = d.db.prepare("SELECT * FROM users WHERE google_sub = ?").get(who.sub) as UserRow | undefined;
    if (!u) {
      res.status(404).type("html").send(page("No Camberstack connection", `<p>${esc(who.email)} hasn't connected Camberstack yet.
Add it to your AI app first (<a href="/#setup">how to connect</a>), then come back here.</p>`));
      return;
    }
    auth.open(res, u.id);
    res.redirect(302, who.next === "/account?upgrade=1" ? who.next : "/account");
  });

  app.post("/account/logout", (req, res) => { auth.close(req, res); res.redirect(303, "/"); });

  app.post("/account/disconnect", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const u = user(req);
    if (!u) { res.redirect(303, "/account"); return; }
    if (req.body?.confirm !== "yes") { res.redirect(303, "/account#disconnect"); return; }
    await d.session(u.id).disconnect();
    auth.close(req, res);
    res.type("html").send(page("Disconnected", `<p>Camberstack's access to your Google Ads account is revoked and the stored Google credentials are deleted.
Your AI app can no longer use Camberstack until you connect again.</p>
<p>Your change history is kept so you can see what was changed. To have it deleted, email <a href="mailto:adam@camberstack.io">adam@camberstack.io</a>.</p>`));
  });

  app.get("/account", (req, res) => {
    const u = user(req);
    // "Upgrade to Pro" on the pricing section lands on /account?upgrade=1. Signed in: a free user goes
    // straight to Stripe Checkout. Signed out: the sign-in link carries the intent through Google (in
    // the sign-in's own state, so an abandoned click can't hijack a later, ordinary sign-in).
    const wantsUpgrade = req.query.upgrade === "1";
    if (u && wantsUpgrade) {
      const p = d.session(u.id).plan();
      if ("upgrade_url" in p && p.upgrade_url) { res.redirect(303, p.upgrade_url); return; }
    }
    if (!u) {
      res.type("html").send(shell("Your account", `<div class="signin"><div class="card">
<h1 style="font-size:26px;margin:0">Your Camberstack account</h1>
<p class="muted">${req.query.upgrade === "1" ? "Sign in to upgrade to Pro. You'll go straight to checkout." : "See your plan, every change Camberstack made to your Google Ads, and manage billing or disconnect."}</p>
<a class="btn" href="/account/login${wantsUpgrade ? "?next=upgrade" : ""}">Sign in with Google</a>
<p class="muted" style="font-size:14px">Use the Google account you connected to your AI app. We only ask for your email address here.</p>
</div></div>`));
      return;
    }
    const s = d.session(u.id);
    const plan = s.plan();
    const history = s.history(undefined, 50);
    const apps = d.db.prepare(`SELECT coalesce(json_extract(cl.info, '$.client_name'), 'AI app') name, max(c.at) last FROM tool_calls c
      LEFT JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = ? GROUP BY 1 ORDER BY last DESC`).all(u.id) as { name: string }[];
    const lastUsed = (d.db.prepare("SELECT max(at) t FROM tool_calls WHERE user_id = ?").get(u.id) as { t: number | null }).t;

    // An applied undo folds into the change it reversed; everything else is its own entry.
    const undoneBy = new Map(history.filter((h) => h.undo_of && h.status === "applied").map((h) => [h.undo_of!, h]));
    const entries = history.filter((h) => !(h.undo_of && h.status === "applied"));

    const planCard = plan.plan === "pro"
      ? `<div class="card"><p class="label">Plan</p><p class="big">Pro${"complimentary" in plan ? ` <span class="chip">complimentary</span>` : ""}</p>
<p class="muted">${plan.accounts_in_use.length} of ${plan.accounts_included} Google Ads accounts in use (last ${ACCOUNT_WINDOW_DAYS} days).${"complimentary" in plan ? " No subscription on this account, so nothing to manage or cancel." : ""}</p>
${"manage_billing" in plan && plan.manage_billing ? `<a class="btn" href="${esc(plan.manage_billing)}">Manage billing</a>` : ""}</div>`
      : (() => {
        const used = plan.accounts_in_use;
        return `<div class="card"><p class="label">Plan</p><p class="big">Free</p>
<p class="muted">Every tool, with unlimited applied changes, on ${plan.accounts_included} Google Ads account.
${used.length ? `In use (last ${ACCOUNT_WINDOW_DAYS} days): <strong style="color:var(--fg)">${used.map((c) => esc(fmtCid(c))).join(", ")}</strong>.` : "Not used on an account yet."}
Pro covers up to 10.</p>
${"upgrade_url" in plan && plan.upgrade_url ? `<a class="btn" href="${esc(plan.upgrade_url)}">Upgrade to Pro · ${PRO_PRICE_LABEL}</a>` : ""}</div>`;
      })();

    const connCard = `<div class="card"><p class="label">Connection</p>
<p class="big" style="font-size:20px"><span class="dot${u.enc_refresh ? " ok" : ""}"></span>${u.enc_refresh ? "Connected to Google Ads" : "Disconnected"}</p>
${apps.length ? `<div class="chips">${apps.map((a) => `<span class="chip">${esc(a.name)}</span>`).join("")}</div>` : ""}
<p class="muted">${u.enc_refresh ? (lastUsed ? `Last used ${when(lastUsed * 1000)}.` : "Not used yet.") : "Connect again from your AI app to use Camberstack."}</p></div>`;

    const changes = entries.map((h) => {
      const undo = undoneBy.get(h.proposal_id);
      const state = undo ? "undone" : h.undo_of ? "proposed" : h.status;
      const label = undo ? `Undone ${when(Date.parse(undo.applied_at ?? undo.proposed_at))}`
        : h.undo_of ? "Undo waiting for approval" : ({ applied: "Applied", proposed: "Waiting for approval", failed: "Failed", discarded: "Discarded" } as Record<string, string>)[h.status] ?? h.status;
      const lines = h.summary.split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
      const canUndo = h.status === "applied" && !undo && !h.undo_of;
      return `<div class="change"><div class="change-top"><span class="change-meta">${when(Date.parse(h.applied_at ?? h.proposed_at))} · account ${esc(fmtCid(h.customer_id))}</span>
<span class="pill ${state}">${esc(label)}</span></div>
<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${canUndo ? `<div class="change-foot"><span>To reverse it, paste this into your AI:</span>
<button class="copy" type="button" data-copy="Undo Camberstack proposal ${esc(h.proposal_id)}">Copy undo request</button></div>` : ""}</div>`;
    }).join("");

    res.type("html").send(shell("Your account", `<div class="acct">
<div class="acct-head"><h1>Your account</h1><form method="post" action="/account/logout" class="who muted">${esc(u.email)} · <button class="linkish">Sign out</button></form></div>
<div class="grid">${planCard}${connCard}</div>
<h2>Changes</h2>
${entries.length ? changes : `<div class="card"><p class="muted">No changes yet. Ask your AI about your Google Ads account to start.</p></div>`}
<h2 id="disconnect">Disconnect</h2>
${u.enc_refresh ? `<form method="post" action="/account/disconnect" class="danger"><p>Revokes Camberstack's Google access and deletes the stored credentials. Your AI app stops working with Camberstack until you connect again. Your change history stays here.</p>
<label><input type="checkbox" name="confirm" value="yes" required> I want to disconnect</label><button class="btn-danger">Disconnect Google Ads</button></form>`
  : `<p class="muted">Already disconnected.</p>`}
</div>
${COPY_JS}`));
  });

  return auth;
}
