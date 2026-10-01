/**
 * The public pages. The homepage and privacy policy double as what Google's brand verification
 * reviews: they must name the app, say what it does with Google user data, and link the policy.
 */

const CONTACT = "adam@camberstack.io";
const UPDATED = "2026-09-29";

const CSS = `
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#5d5a53;--line:#e4e0d8;--card:#fff;--accent:#1f5f4a;--accent-fg:#fff;--code:#f1eee7}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a8a59c;--line:#2e2d2a;--card:#1b1b19;--accent:#6fc4a4;--accent-fg:#0d1f19;--code:#232320}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line)}header .wrap{display:flex;justify-content:space-between;align-items:center;height:60px}
.brand{font-weight:700;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:15px}nav a:hover{color:var(--fg)}
h1{font-size:clamp(30px,5vw,44px);line-height:1.15;letter-spacing:-.02em;margin:56px 0 16px}
h2{font-size:24px;letter-spacing:-.01em;margin:56px 0 12px}h3{font-size:18px;margin:24px 0 6px}
p,li{color:var(--fg)}.lede{font-size:20px;color:var(--muted);max-width:680px}
.muted{color:var(--muted)}a{color:var(--accent)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.card h3{margin-top:0}
code,pre{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:2px 5px}pre{padding:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.convo{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:24px}
.convo p{margin:8px 0}.who{font-weight:600;color:var(--muted);font-size:14px;text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
footer{border-top:1px solid var(--line);margin-top:72px;padding:28px 0;font-size:14px;color:var(--muted)}
footer a{color:var(--muted);margin-right:16px}
.legal h2{font-size:20px;margin-top:36px}
`;

function layout(o: { title: string; description: string; path: string; body: string; baseUrl: string; jsonLd?: object }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${o.baseUrl}${o.path}">
<meta property="og:title" content="${o.title}"><meta property="og:description" content="${o.description}">
<meta property="og:url" content="${o.baseUrl}${o.path}"><meta property="og:type" content="website">
<meta property="og:image" content="${o.baseUrl}/logo.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/logo.png">
<style>${CSS}</style>
${o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd)}</script>` : ""}
</head><body>
<header><div class="wrap"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24" style="vertical-align:-5px;margin-right:8px">Camberstack</a>
<nav><a href="/#setup">Connect</a><a href="/#pricing">Pricing</a><a href="/privacy">Privacy</a></nav></div></header>
<main class="wrap">${o.body}</main>
<footer><div class="wrap">
<a href="/privacy">Privacy policy</a><a href="/terms">Terms</a><a href="mailto:${CONTACT}">${CONTACT}</a>
<p>Camberstack is independent and not affiliated with or endorsed by Google. Google Ads is a trademark of Google LLC.</p>
</div></footer>
<script src="/e.js" defer></script>
</body></html>`;
}

export function homePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/",
    title: "Camberstack: Google Ads MCP that finds wasted spend",
    description: "Connect Google Ads to Claude or ChatGPT. Your AI finds where the budget is wasted, proposes fixes, and applies only the changes you approve. Every change is logged and can be undone.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Camberstack",
      applicationCategory: "BusinessApplication", operatingSystem: "Web", url: baseUrl,
      description: "Google Ads MCP connector for Claude and ChatGPT: diagnose wasted spend, then apply approved changes.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    body: `
<h1>Your AI, on your Google Ads account. It finds the waste. You approve every change.</h1>
<p class="lede">Camberstack is a Google Ads connector (an MCP server) for Claude, ChatGPT and other AI assistants.
Ask where your budget is going; it reads your account, shows you the search terms and keywords that spend without converting,
and prepares the fix. Nothing changes in your account until you say yes.</p>
<p><a class="btn" href="#setup">Connect in 2 minutes</a> <span class="muted">&nbsp;Free during beta</span></p>

<div class="convo" aria-label="Example conversation">
<p class="who">You</p><p>Where did my Google Ads budget go last month, and what should I cut?</p>
<p class="who">Your AI, using Camberstack</p>
<p>Conversion tracking looks healthy (1 primary action: "Purchase"). You spent $2,140 at $61 per conversion.
$486 went to search terms that never converted. The biggest: <code>free invoice template</code> ($112, 41 clicks) and
<code>invoice clerk jobs</code> ($64). I can add "free" and "jobs" as phrase negatives to your Search campaign,
plus 6 exact negatives. Want me to prepare that?</p>
<p class="who">You</p><p>Yes, but keep "free trial".</p>
<p class="muted">An illustration of the workflow, not a real account.</p>
</div>

<h2>How it works</h2>
<div class="grid">
<div class="card"><h3>1. Connect</h3><p>Add Camberstack to your AI app and sign in with Google. You grant Google Ads access only.</p></div>
<div class="card"><h3>2. Ask</h3><p>"What's wasting money?" It checks your conversion tracking first, then your search terms, keywords and campaigns.</p></div>
<div class="card"><h3>3. Approve</h3><p>Changes are proposed as a plain-English list and dry-run with Google first. They apply only when you approve, and can be undone.</p></div>
</div>

<h2>What it checks, in order</h2>
<ol>
<li><strong>Is conversion tracking telling the truth?</strong> No primary conversion action, or a page view counted as a conversion, makes every other number misleading. It says so before recommending any cut.</li>
<li><strong>Search terms that spent a conversion's worth with nothing to show.</strong> Your own cost per conversion is the bar.</li>
<li><strong>Low-intent searches</strong> such as "free", jobs, how-to and login, only when none of them ever converted for you.</li>
<li><strong>Keywords</strong> that spent twice your cost per conversion with zero conversions.</li>
</ol>

<h2>What it can change</h2>
<table>
<tr><th>Change</th><th>Undo</th></tr>
<tr><td>Add negative keywords to a campaign</td><td>Removes exactly the negatives it added</td></tr>
<tr><td>Pause or re-enable a keyword or ad group</td><td>Restores the previous status</td></tr>
<tr><td>Change a campaign's daily budget (not shared budgets)</td><td>Restores the previous amount</td></tr>
</table>
<p class="muted">It cannot create or delete campaigns, change bid strategies, touch billing, or edit anything outside Google Ads.
Any question beyond these tools is answered with read-only queries.</p>

<h2 id="setup">Connect</h2>
<p>Server URL:</p>
<pre>${mcpUrl}</pre>
<h3>Claude (claude.ai or desktop)</h3>
<p>Settings → Connectors → <em>Add custom connector</em> → paste the URL above → Connect, then sign in with Google.</p>
<h3>Claude Code</h3>
<pre>claude mcp add --transport http camberstack ${mcpUrl}</pre>
<h3>ChatGPT</h3>
<p>Settings → Apps &amp; Connectors → Advanced → enable Developer mode → Create → paste the URL, authentication OAuth.</p>
<h3>Cursor, VS Code, others</h3>
<pre>{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }</pre>
<p class="muted">Your AI app handles sign-in. Google will show "Camberstack wants to access your Google Ads" before anything is shared.</p>

<h2 id="pricing">Pricing</h2>
<div class="grid">
<div class="card"><h3>Beta: free</h3><p>Everything, including applying approved changes, while in beta.</p></div>
<div class="card"><h3>Pro: $49/month (after beta)</h3><p>Applying approved changes, full change history and undo, up to 3 accounts. Diagnosis and proposals stay free.</p></div>
</div>

<h2>Questions</h2>
<h3>Can the AI change my account without asking?</h3>
<p>No. Changes are only ever stored as a proposal first. Applying one is a separate step that your AI app asks you to allow,
and the server refuses anything that wasn't proposed first, is older than 24 hours, or belongs to someone else.</p>
<h3>What data do you keep?</h3>
<p>Your Google email, an encrypted Google refresh token, and the proposals you make (with their results, so you can undo them).
Reports and query results are not stored. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>How do I disconnect?</h3>
<p>Ask your AI to use the <code>disconnect</code> tool, or remove Camberstack at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<h3>Does it work with a manager (MCC) account?</h3>
<p>Yes. It lists the client accounts under any manager your login can reach.</p>
`,
  });
}

export function privacyPage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/privacy",
    title: "Privacy policy | Camberstack",
    description: "What Camberstack does with your Google account and Google Ads data.",
    body: `<div class="legal">
<h1>Privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>Camberstack ("we") runs camberstack.io, a connector that lets an AI assistant you choose read and, with your approval,
change your Google Ads account. This policy explains what we access, why, and what we keep.</p>

<h2>What we access</h2>
<ul>
<li><strong>Your Google account email and a stable Google account ID</strong> (the <code>openid</code> and <code>email</code> scopes), so the same person gets the same account and change history each time.</li>
<li><strong>Your Google Ads data</strong> (the <code>https://www.googleapis.com/auth/adwords</code> scope): account and campaign structure, performance metrics, search terms, keywords and conversion settings, read when your AI assistant calls a Camberstack tool.</li>
</ul>
<p>We request nothing else from your Google account: no Gmail, Drive, contacts or calendar.</p>

<h2>How we use it</h2>
<ul>
<li>To answer the requests your AI assistant makes on your behalf (reports, waste diagnosis, read-only queries).</li>
<li>To apply changes to your Google Ads account <strong>only</strong> when you approve a specific proposal, and to reverse them if you ask.</li>
</ul>
<p>We do not sell your data, use it for advertising, share it with data brokers, or use it to train AI or machine-learning models.
Humans at Camberstack do not read your Google Ads data unless you ask us to for support, it is needed for security or abuse investigation, or the law requires it.</p>

<h2>Google API Services: Limited Use</h2>
<p>Camberstack's use and transfer of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>What we store</h2>
<table>
<tr><th>Data</th><th>Why</th><th>Kept until</th></tr>
<tr><td>Google email and account ID</td><td>Identify you across connections</td><td>You ask us to delete it</td></tr>
<tr><td>Google refresh token, encrypted (AES-256-GCM)</td><td>Call the Google Ads API when you use a tool</td><td>You disconnect or revoke access</td></tr>
<tr><td>Tokens we issue to your AI app (stored as hashes)</td><td>Authenticate your AI app</td><td>Expiry (1 hour access, 90 days refresh) or disconnect</td></tr>
<tr><td>Proposals: the changes requested, their summary and results</td><td>Show what changed and let you undo it</td><td>You ask us to delete them</td></tr>
<tr><td>A usage log: which tool ran, for which Google Ads account ID, when, how long it took and any error message. Never the tool's inputs or results</td><td>Find and fix failures, and see which features are used</td><td>You ask us to delete it</td></tr>
</table>
<p>Reports, search-term lists and query results are computed on request and returned to your AI assistant. We do not store them.
Standard web server logs (IP address, time, path) are kept for a limited period for security and then deleted.</p>

<h2>Your AI assistant</h2>
<p>Tool results go to the AI app you connected (for example Claude or ChatGPT). How that provider handles the conversation is governed by its own privacy policy.</p>

<h2>Where it runs</h2>
<p>Camberstack runs on infrastructure we operate in the United States. We use no third-party analytics on your Google data.</p>

<h2>Website analytics</h2>
<p>We count visits to this website's pages with Matomo, which we host ourselves on the same infrastructure. A small script served from this site sends the page you opened and the site that linked you here; we also record that a Google Ads account was connected, with no account, email or ID attached. It sets no cookie and stores nothing in your browser. Matomo uses your IP address to estimate roughly where a visit came from and removes the last part of it before saving. Visits are grouped by a salted hash of your IP address and browser, with the salt changed daily and kept only in memory, so it cannot identify you or link visits across days. None of your Google data is sent to analytics, and we use no third-party analytics or advertising scripts.</p>

<h2>Your choices</h2>
<ul>
<li><strong>Disconnect:</strong> ask your AI to run the <code>disconnect</code> tool, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Either stops all access; the tool also deletes the stored token.</li>
<li><strong>Delete everything:</strong> email <a href="mailto:${CONTACT}">${CONTACT}</a> from your Google account's address and we delete your account and change history within 30 days.</li>
</ul>

<h2>Security</h2>
<p>All traffic uses HTTPS. Google refresh tokens are encrypted at rest; tokens we issue are stored only as SHA-256 hashes.
Changes are validated with Google before you approve them and are limited to the operations listed on the homepage.</p>

<h2>Children</h2>
<p>Camberstack is a business tool and not directed at anyone under 18.</p>

<h2>Changes and contact</h2>
<p>We will post changes here and update the date above. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</div>`,
  });
}

export function termsPage(baseUrl: string): string {
  return layout({
    baseUrl, path: "/terms",
    title: "Terms of service | Camberstack",
    description: "Terms for using Camberstack.",
    body: `<div class="legal">
<h1>Terms of service</h1>
<p class="muted">Last updated ${UPDATED}</p>
<h2>The service</h2>
<p>Camberstack lets an AI assistant read your Google Ads account and, when you approve a specific proposal, change it.
It is in beta and offered free during the beta.</p>
<h2>You stay in control, and responsible</h2>
<p>Recommendations are generated from your account data and may be wrong. You decide what to approve, and you are responsible
for changes you approve and for your Google Ads spend. Review proposals before approving them.</p>
<h2>Acceptable use</h2>
<p>Use Camberstack only on Google Ads accounts you are authorized to manage, and in line with Google's policies. Don't attempt to access other users' data or overload the service.</p>
<h2>No warranty</h2>
<p>The service is provided "as is", without warranties of any kind, including fitness for a particular purpose or uninterrupted availability.</p>
<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, Camberstack is not liable for indirect or consequential losses, including lost profits or ad spend,
and our total liability is limited to the amount you paid us in the 12 months before the claim (zero during the free beta).</p>
<h2>Ending</h2>
<p>You can disconnect at any time. We may suspend access that breaks these terms or Google's policies.</p>
<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</div>`,
  });
}

export function errorPage(baseUrl: string, message: string): string {
  return layout({ baseUrl, path: "/", title: "Connection problem | Camberstack", description: message,
    body: `<h1>That didn't work</h1><p class="lede">${escapeHtml(message)}</p><p><a href="/#setup">Connection instructions</a></p>` });
}

export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nDisallow: /admin\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

export function sitemapXml(baseUrl: string, lastmod: string): string {
  const urls = ["/", "/privacy", "/terms"];
  const lm = lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${baseUrl}${u}</loc>${lm}</url>`).join("\n")}\n</urlset>\n`;
}

export function llmsTxt(baseUrl: string): string {
  return `# Camberstack

> Google Ads MCP server. Connect Google Ads to Claude, ChatGPT or any MCP client; the AI diagnoses wasted spend and applies only changes the user approves.

- MCP endpoint (Streamable HTTP, OAuth 2.1 with dynamic client registration): ${baseUrl}/mcp
- Tools: list_accounts, account_overview, find_wasted_spend, run_gaql, propose_changes, apply_changes, undo_changes, discard_proposal, change_history, disconnect
- Writes are limited to: negative keywords, pause/enable keyword or ad group, daily budget. Every applied change can be undone.
- [Setup](${baseUrl}/#setup)
- [Privacy](${baseUrl}/privacy)
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
