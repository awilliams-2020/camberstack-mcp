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
import { infoPage } from "./pages.js";

export interface AccountDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  fetch?: typeof fetch;
  session: (userId: string) => UserSession;
  billingLink: (kind: "upgrade" | "billing", userId: string) => string | null;
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function mountAccount(app: Express, d: AccountDeps): SignIn {
  const auth = new SignIn(d, "acc_", "cs_account", "/account", 7 * 86400);
  const user = (req: Request): UserRow | undefined => {
    const id = auth.subject(req);
    return id ? d.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined : undefined;
  };
  const page = (title: string, body: string) => infoPage(d.baseUrl, title, body);

  app.use("/account", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/account/login", (_req, res) => {
    if (!d.google.clientId) { res.status(503).type("html").send(page("Sign-in unavailable", "<p>Google sign-in is not configured.</p>")); return; }
    auth.start(res);
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
    res.redirect(302, "/account");
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
    if (!u) {
      res.type("html").send(page("Your account", `<p>See your plan, every change Camberstack made to your Google Ads account, and manage billing or disconnect.</p>
<p><a class="btn" href="/account/login">Sign in with Google</a></p>
<p class="muted">Use the Google account you connected to your AI app. We only ask for your email address here.</p>`));
      return;
    }
    const s = d.session(u.id);
    const plan = s.plan();
    const history = s.history(undefined, 50);
    const apps = d.db.prepare(`SELECT DISTINCT coalesce(json_extract(cl.info, '$.client_name'), 'AI app') name FROM tool_calls c
      LEFT JOIN clients cl ON cl.client_id = c.client_id WHERE c.user_id = ? ORDER BY c.at DESC`).all(u.id) as { name: string }[];
    const undone = new Set(history.filter((h) => h.undo_of && h.status === "applied").map((h) => h.undo_of));

    const planBox = plan.plan === "pro"
      ? `<p><strong>Pro.</strong> Applying changes is unlimited.</p>${"manage_billing" in plan && plan.manage_billing
        ? `<p><a class="btn" href="${esc(plan.manage_billing)}">Manage billing</a> <span class="muted">Change card, see invoices or cancel.</span></p>` : ""}`
      : `<p><strong>Free.</strong> ${"free_applies_left" in plan ? `${plan.free_applies_left} of ${plan.free_applies_total} free applied changes left.` : ""}
Diagnosis, proposals, history and undo are always free.</p>
${"upgrade_url" in plan && plan.upgrade_url ? `<p><a class="btn" href="${esc(plan.upgrade_url)}">Upgrade to Pro, $49/month</a> <span class="muted">Unlimited applied changes. Cancel any time.</span></p>` : ""}`;

    const rows = history.map((h) => {
      const status = h.undo_of ? `undo of ${esc(h.undo_of.slice(0, 8))}: ${esc(h.status)}` : undone.has(h.proposal_id) ? "applied, then undone" : esc(h.status);
      return `<tr><td>${esc((h.applied_at ?? h.proposed_at).slice(0, 16).replace("T", " "))}</td><td>${esc(h.customer_id)}</td>
<td style="white-space:pre-line">${esc(h.summary)}</td><td>${status}</td><td><code>${esc(h.proposal_id.slice(0, 8))}</code></td></tr>`;
    }).join("");

    res.type("html").send(page("Your account", `
<p>${esc(u.email)} · <form method="post" action="/account/logout" style="display:inline"><button class="linkish">Sign out</button></form></p>
<h2>Plan</h2>${planBox}
<h2>Connection</h2>
<p>${u.enc_refresh ? "Connected to Google Ads." : "Disconnected. Connect again from your AI app to use Camberstack."}
${apps.length ? ` Used from: ${apps.map((a) => esc(a.name)).join(", ")}.` : ""}</p>
<h2>Changes</h2>
${history.length ? `<p class="muted">Every proposal made through Camberstack, newest first. To reverse one, ask your AI to undo it by its id.</p>
<div style="overflow-x:auto"><table><tr><th>When (UTC)</th><th>Account</th><th>What</th><th>Status</th><th>Id</th></tr>${rows}</table></div>`
  : `<p class="muted">No changes yet. Ask your AI "what's wasting money in my Google Ads account?" to start.</p>`}
<h2 id="disconnect">Disconnect</h2>
${u.enc_refresh ? `<form method="post" action="/account/disconnect"><p>Revokes Camberstack's Google access and deletes the stored credentials. Your change history stays visible here.</p>
<label><input type="checkbox" name="confirm" value="yes" required> I want to disconnect</label> <button>Disconnect</button></form>`
  : `<p class="muted">Already disconnected.</p>`}`));
  });

  return auth;
}
