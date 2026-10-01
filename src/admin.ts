/**
 * The operator's live view of usage (report.ts), served ONLY on its own host (ADMIN_URL, e.g.
 * https://admin.camberstack.io), at its root. Google sign-in (signin.ts) allowed for ADMIN_EMAILS;
 * with ADMIN_URL or that list unset, the admin site does not exist. The main site has no /admin.
 */
import express, { type Express, type Request } from "express";
import type { DB } from "./db.js";
import type { GoogleCreds } from "./google.js";
import { SignIn } from "./signin.js";
import { buildReport, type Report } from "./report.js";
import { now } from "./db.js";

export interface AdminDeps {
  db: DB;
  google: GoogleCreds;
  baseUrl: string;
  /** The admin site's origin. */
  adminUrl?: string;
  adminEmails: Set<string>;
  /** Hidden from the numbers by default (operator + testers); the page can include them. */
  internalEmails: Set<string>;
  fetch?: typeof fetch;
}

/** Mount first: requests for the admin host never reach the public site's routes. */
export function mountAdmin(app: Express, d: AdminDeps): SignIn | null {
  if (!d.adminUrl || !d.adminEmails.size) return null;
  const host = new URL(d.adminUrl).host;
  const auth = new SignIn(d, "adm_", "cs_admin", "/", 12 * 3600, d.adminUrl);
  const email = (req: Request) => {
    const e = auth.subject(req);
    return e && d.adminEmails.has(e) ? e : null;
  };

  const site = express.Router();
  site.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  site.get("/robots.txt", (_q, r) => { r.type("text/plain").send("User-agent: *\nDisallow: /\n"); });
  site.get("/login", (_req, res) => {
    if (!d.google.clientId) { res.status(503).send("Google sign-in is not configured."); return; }
    auth.start(res);
  });
  site.get("/callback", async (req, res) => {
    const who = await auth.finish(req);
    if (!who) { res.status(400).send('Sign-in expired or was cancelled. <a href="/login">Try again</a>.'); return; }
    if (!d.adminEmails.has(who.email)) { res.status(403).send("Not an admin account."); return; }
    auth.open(res, who.email);
    res.redirect(302, "/");
  });
  site.post("/logout", (req, res) => { auth.close(req, res); res.redirect(303, d.baseUrl); });
  site.get("/", (req, res) => {
    const who = email(req);
    if (!who) { res.redirect(302, "/login"); return; }
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const all = req.query.internal === "1";
    const report = buildReport(d.db, { days, exclude: all ? [] : [...d.internalEmails] });
    if (req.query.format === "json") { res.json(report); return; }
    res.type("html").send(adminPage(report, { email: who, days, all, internal: d.internalEmails.size }));
  });
  site.use((_req, res) => { res.status(404).send("Not found."); });

  app.use((req, res, next) => (req.get("host") === host ? site(req, res, next) : next()));
  return auth;
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
    return `/?days=${days}${all ? "&internal=1" : ""}`;
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
<header><h1>Camberstack admin</h1><form method="post" action="/logout" class="muted">${esc(o.email)} <button>Sign out</button></form></header>
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

<h2>Ad conversions and emails</h2>
${table(["ad connects recorded", "uploaded to Google Ads", "failing", "last error"], [[r.adConversions?.recorded ?? 0, r.adConversions?.uploaded ?? 0,
  r.adConversions?.failing ? `<span class="bad">${r.adConversions.failing}</span>` : 0, esc(r.adConversions?.last_error ?? "—")]])}
${table(["email", "sent (all time)", `sent in ${o.days}d`], r.emails.map((e) => [esc(e.kind), e.sent, e.in_window]), "No lifecycle emails sent yet.")}

<h2>Recent calls</h2>
${table(["when (UTC)", "user", "tool", "account", "ms", "result", "app"], r.recent.map((c) => [date(c.at), esc(c.email), esc(c.tool),
  esc(c.customer_id ?? ""), c.ms, c.ok ? "ok" : `<span class="bad">${esc(c.error)}</span>`, esc(c.client)]))}

<p class="muted">Usage comes from our own database; page visits are in Matomo (site 7).</p>
</div></body></html>`;
}
