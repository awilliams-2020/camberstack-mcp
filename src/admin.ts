/**
 * /admin: the operator's live view of usage (report.ts). Sign-in is Google identity only (openid
 * email, no Ads scope), allowed for ADMIN_EMAILS; with that list empty the routes don't exist.
 *
 * It reuses the registered Google redirect URI (/oauth/google/callback): admin states start with
 * ADMIN_STATE, and server.ts routes those here. That keeps the verified OAuth client untouched.
 */
import express, { type Express, type Request, type Response } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { exchangeGoogleCode, googleSignInUrl, idTokenClaims, type GoogleCreds } from "./google.js";
import { buildReport, type Report } from "./report.js";

export const ADMIN_STATE = "adm_";
const COOKIE = "cs_admin";
const SESSION_TTL = 12 * 3600;

export interface AdminDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  adminEmails: Set<string>;
  /** Hidden from the numbers by default (operator + testers); the page can include them. */
  internalEmails: Set<string>;
  fetch?: typeof fetch;
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function mountAdmin(app: Express, d: AdminDeps): { completeCallback: (req: Request, res: Response) => Promise<void> } {
  const redirectUri = `${d.baseUrl}/oauth/google/callback`;
  const secure = d.baseUrl.startsWith("https://");
  const setCookie = (res: Response, value: string, maxAge: number) =>
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);

  const sessionEmail = (req: Request): string | null => {
    const t = cookie(req, COOKIE);
    if (!t) return null;
    const row = d.db.prepare("SELECT email, expires_at FROM admin_sessions WHERE token_hash = ?").get(sha256(t)) as
      { email: string; expires_at: number } | undefined;
    return row && row.expires_at > now() && d.adminEmails.has(row.email) ? row.email : null;
  };

  app.use("/admin", (_req, res, next) => {
    if (!d.adminEmails.size) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get("/admin/login", (_req, res) => {
    if (!d.google.clientId) { res.status(503).send("Google sign-in is not configured."); return; }
    const id = ADMIN_STATE + randomToken(24);
    d.db.prepare("INSERT INTO pending_auth (id, client_id, params, created_at) VALUES (?, '__admin__', '{}', ?)").run(id, now());
    res.redirect(302, googleSignInUrl(d.google, redirectUri, id));
  });

  app.post("/admin/logout", (req, res) => {
    const t = cookie(req, COOKIE);
    if (t) d.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha256(t));
    setCookie(res, "", 0);
    res.redirect(303, "/");
  });

  app.get("/admin", (req, res) => {
    const email = sessionEmail(req);
    if (!email) { res.redirect(302, "/admin/login"); return; }
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const all = req.query.internal === "1";
    const report = buildReport(d.db, { days, exclude: all ? [] : [...d.internalEmails] });
    if (req.query.format === "json") { res.json(report); return; }
    res.type("html").send(adminPage(report, { email, days, all, internal: d.internalEmails.size }));
  });

  return {
    async completeCallback(req, res) {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const row = d.db.prepare("SELECT created_at FROM pending_auth WHERE id = ? AND client_id = '__admin__'").get(state) as
        { created_at: number } | undefined;
      d.db.prepare("DELETE FROM pending_auth WHERE id = ?").run(state);
      if (!row || row.created_at < now() - 600 || !code) { res.status(400).send("Sign-in expired or was cancelled. <a href=\"/admin/login\">Try again</a>."); return; }
      const g = await exchangeGoogleCode(d.google, code, redirectUri, d.fetch);
      const claims = g.id_token ? idTokenClaims(g.id_token) : null;
      if (!claims?.emailVerified || !d.adminEmails.has(claims.email)) { res.status(403).send("Not an admin account."); return; }
      const token = randomToken();
      d.db.prepare("INSERT INTO admin_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)").run(sha256(token), claims.email, now() + SESSION_TTL);
      setCookie(res, token, SESSION_TTL);
      res.redirect(302, "/admin");
    },
  };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ago = (t: number | null) => {
  if (!t) return "—";
  const s = now() - t;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

function table(cols: string[], rows: unknown[][], empty = "Nothing yet."): string {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<div class="scroll"><table><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>${
    rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")}</table></div>`;
}

function adminPage(r: Report, o: { email: string; days: number; all: boolean; internal: number }): string {
  const stages = Object.keys(r.funnel.all) as (keyof Report["funnel"]["all"])[];
  const top = Math.max(1, r.funnel.all.connected);
  const maxCalls = Math.max(1, ...r.daily.map((d) => d.calls));
  const link = (p: Partial<{ days: number; all: boolean }>) => {
    const days = p.days ?? o.days, all = p.all ?? o.all;
    return `/admin?days=${days}${all ? "&internal=1" : ""}`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Camberstack admin</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#9a3412;--bad:#b91c1c;--bar:#fdba74}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--accent:#fb923c;--bad:#f87171;--bar:#9a3412}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:16px}header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:24px 0 8px}.muted{color:var(--muted)}a{color:var(--accent)}
.pills a{display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:99px;text-decoration:none;margin:2px}
.pills a.on{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card);font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500}
td.wrapok{white-space:normal}.bad{color:var(--bad)}.bars{display:flex;align-items:flex-end;gap:3px;height:80px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
.bars div{flex:1;background:var(--bar);min-height:1px;border-radius:2px 2px 0 0}
.fun td:nth-child(3){width:50%}.fun i{display:block;height:10px;background:var(--bar);border-radius:2px}
button{font:inherit;background:none;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer}
</style></head><body><div class="wrap">
<header><h1>Camberstack admin</h1><form method="post" action="/admin/logout" class="muted">${esc(o.email)} <button>Sign out</button></form></header>
<p class="pills">${[1, 7, 30, 90].map((d) => `<a class="${d === o.days ? "on" : ""}" href="${link({ days: d })}">${d}d</a>`).join("")}
 · <a class="${o.all ? "on" : ""}" href="${link({ all: !o.all })}">${o.all ? "including" : "excluding"} ${o.internal} internal account(s)</a>
 · <a href="${link({})}&format=json">JSON</a></p>

<div class="grid">
<div class="tile"><b>${r.funnel.all.connected}</b><span>connected, all time</span></div>
<div class="tile"><b>${r.funnel.window.connected}</b><span>new in ${o.days}d</span></div>
<div class="tile"><b>${r.activeInWindow}</b><span>active in ${o.days}d</span></div>
<div class="tile"><b>${r.funnel.all.applied}</b><span>applied a change</span></div>
<div class="tile"><b>${r.funnel.all.paid}</b><span>paying</span></div>
<div class="tile"><b class="${r.errors.length ? "bad" : ""}">${r.errors.reduce((a, e) => a + e.n, 0)}</b><span>tool errors in ${o.days}d</span></div>
</div>

<h2>Funnel</h2>
${table(["stage", "all time", "", `new in ${o.days}d`], stages.map((k) => [k.replace("_", " "), r.funnel.all[k],
  `<i style="width:${Math.round((100 * r.funnel.all[k]) / top)}%"></i>`, r.funnel.window[k]])).replace("<table>", '<table class="fun">')}

<h2>Calls per day, last ${o.days}d</h2>
${r.daily.length ? `<div class="bars">${r.daily.map((d) => `<div style="height:${Math.round((100 * d.calls) / maxCalls)}%" title="${d.day}: ${d.calls} calls, ${d.users} users, ${d.errors} errors"></div>`).join("")}</div>` : `<p class="muted">No calls in this window.</p>`}

<h2>Users</h2>
${table(["email", "connected", "last seen", "calls", "errors", "applied", "app", "plan", "status"], r.users.map((u) => [
  esc(u.email), date(u.created_at).slice(0, 10), ago(u.last_seen_at), u.calls, u.errors ? `<span class="bad">${u.errors}</span>` : 0,
  u.applied, esc(u.client ?? "—"), esc(u.plan), u.connected ? "connected" : `<span class="muted">disconnected</span>`]))}

<h2>Tools, last ${o.days}d</h2>
${table(["tool", "calls", "users", "errors", "avg ms", "max ms"], r.tools.map((t) => [esc(t.tool), t.calls, t.users,
  t.errors ? `<span class="bad">${t.errors}</span>` : 0, t.avg_ms, t.max_ms]))}

<h2>AI apps, last ${o.days}d</h2>
${table(["app", "calls", "users"], r.clients.map((c) => [esc(c.client), c.calls, c.users]))}

<h2>Errors, last ${o.days}d</h2>
${table(["tool", "error", "count", "last"], r.errors.map((e) => [esc(e.tool), `<span class="bad">${esc(e.error)}</span>`, e.n, ago(e.last)]), "No errors.")
  .replaceAll('<td><span class="bad">', '<td class="wrapok"><span class="bad">')}

<h2>Recent calls</h2>
${table(["when (UTC)", "user", "tool", "account", "ms", "result", "app"], r.recent.map((c) => [date(c.at), esc(c.email), esc(c.tool),
  esc(c.customer_id ?? ""), c.ms, c.ok ? "ok" : `<span class="bad">${esc(c.error)}</span>`, esc(c.client)]))}

<p class="muted">Usage comes from our own database; page visits are in Matomo (site 7).</p>
</div></body></html>`;
}
