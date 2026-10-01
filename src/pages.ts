/**
 * The public pages. The homepage and privacy policy double as what Google's brand verification
 * reviews: they must name the app, say what it does with Google user data, and link the policy.
 */

const CONTACT = "adam@camberstack.io";
const UPDATED = "2026-10-01";

const CSS = `
.linkish{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}
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
.acct{padding:32px 0 8px}
.acct-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:20px}
.acct-head h1{font-size:28px;margin:0}.acct-head .who{text-transform:none;letter-spacing:0;font-weight:400;font-size:15px}
.acct h2{font-size:19px;margin:36px 0 12px}
.acct .grid{margin-top:0}.acct .card{display:flex;flex-direction:column;gap:10px}
.label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0}
.big{font-size:26px;font-weight:700;letter-spacing:-.01em;margin:0}
.meter{display:flex;gap:6px}.meter i{flex:1;height:8px;border-radius:4px;background:var(--line)}.meter i.on{background:var(--accent)}
.acct .card p{margin:0}.acct .card .btn{align-self:flex-start;margin-top:auto}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.ok{background:#2f9e6e}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:13px;border:1px solid var(--line);border-radius:99px;padding:2px 10px;color:var(--muted)}
.change{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.change-top{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between}
.change-meta{font-size:14px;color:var(--muted)}.change ul{margin:8px 0 0;padding-left:20px}.change li{margin:2px 0}
.pill{font-size:12px;font-weight:600;border-radius:99px;padding:2px 9px;white-space:nowrap}
.pill.applied{background:color-mix(in srgb,#2f9e6e 16%,transparent);color:#2f9e6e}
.pill.undone{background:var(--code);color:var(--muted)}
.pill.proposed{background:color-mix(in srgb,#c78a12 18%,transparent);color:#b07a10}
.pill.failed{background:color-mix(in srgb,#c2412d 16%,transparent);color:#c2412d}
.pill.discarded{background:var(--code);color:var(--muted)}
.change-foot{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:10px;font-size:13px;color:var(--muted)}
.copy{font:inherit;font-size:13px;background:none;border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--fg);cursor:pointer}
.danger{border:1px solid color-mix(in srgb,#c2412d 40%,var(--line));border-radius:10px;padding:16px}
.danger p{margin:0 0 12px}.danger label{display:block;margin-bottom:12px}
.btn-danger{font:inherit;font-weight:600;background:#c2412d;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
.signin{max-width:440px;margin:72px auto 96px;text-align:center}.signin .card{display:flex;flex-direction:column;gap:16px;align-items:center;padding:36px 32px}.signin .btn{align-self:center}
@media (max-width:600px){
.btn{padding:9px 14px;font-size:15px;border-radius:7px}
.btn-danger{padding:9px 14px;font-size:15px}
.signin{margin:40px auto 56px}.signin .card{padding:28px 20px}
.big{font-size:22px}
}
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
<nav><a href="/#setup">Connect</a><a href="/#pricing">Pricing</a><a href="/account">Account</a></nav></div></header>
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
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD",
          description: "Unlimited diagnosis and proposals, change history and undo, plus 3 applied changes." },
        { "@type": "Offer", name: "Pro", price: "49", priceCurrency: "USD", description: "Unlimited applied changes.",
          priceSpecification: { "@type": "UnitPriceSpecification", price: "49", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } },
      ],
    },
    body: `
<h1>Your AI, on your Google Ads account. It finds the waste. You approve every change.</h1>
<p class="lede">Camberstack is a Google Ads connector (an MCP server) for Claude, ChatGPT and other AI assistants.
Ask where your budget is going; it reads your account, shows you the search terms and keywords that spend without converting,
and prepares the fix. Nothing changes in your account until you say yes.</p>
<p><a class="btn" href="#setup">Connect in 2 minutes</a> <span class="muted">&nbsp;Free plan, no card</span></p>

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
<tr><td>Pause or re-enable a campaign, ad group or keyword</td><td>Restores the previous status</td></tr>
<tr><td>Change a campaign's daily budget (not shared budgets)</td><td>Restores the previous amount</td></tr>
</table>
<p class="muted">Turning a campaign back on, or more than doubling a budget, is flagged with a warning in the proposal before you approve it.
It cannot create or delete campaigns, change bid strategies, touch billing, or edit anything outside Google Ads.
Any question beyond these tools is answered with read-only queries.</p>

<h2 id="setup">Connect</h2>
<p>Server URL:</p>
<pre>${mcpUrl}</pre>
<h3>Claude (claude.ai or desktop) · <a href="/google-ads-claude">step-by-step guide</a></h3>
<p>Settings → Connectors → <em>Add custom connector</em> → paste the URL above → Connect, then sign in with Google.</p>
<h3>Claude Code</h3>
<pre>claude mcp add --transport http camberstack ${mcpUrl}</pre>
<h3>ChatGPT</h3>
<p>Settings → Apps &amp; Connectors → Advanced → enable Developer mode → Create → paste the URL, authentication OAuth.</p>
<h3>Cursor, VS Code, others</h3>
<pre>{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }</pre>
<p class="muted">Your AI app handles sign-in. Google will show "Camberstack wants to access your Google Ads" before anything is shared.</p>
<h3>Want to look first?</h3>
<p>Connect, then ask <em>"Show me Camberstack's demo account"</em>. It's a sample plumbing business with six months of
campaigns and search terms, so you can try diagnosis, proposals, applying and undo without touching a real account.
Changes there never reach Google and don't use your free changes. A Google login with no Google Ads access gets the demo automatically.</p>

<h2 id="pricing">Pricing</h2>
<div class="grid">
<div class="card"><h3>Free</h3><p>Unlimited diagnosis and proposals, change history and undo, plus <strong>3 applied changes</strong>. No card. Free stays free.</p>
<p><a class="btn" href="#setup">Connect for free</a></p></div>
<div class="card"><h3>Pro: $49/month</h3><p>Everything in Free, with <strong>unlimited applied changes</strong>. Cancel any time; you keep Pro until the end of the month you paid for.</p>
<p><a class="btn" href="/account?upgrade=1">Upgrade to Pro</a></p><p class="muted" style="font-size:14px">Connect Camberstack to your AI app first; you'll sign in with the same Google account.</p></div>
</div>

<h2>Questions</h2>
<h3>Can the AI change my account without asking?</h3>
<p>No. Changes are only ever stored as a proposal first. Applying one is a separate step that your AI app asks you to allow,
and the server refuses anything that wasn't proposed first, is older than 24 hours, or belongs to someone else.</p>
<h3>What data do you keep?</h3>
<p>Your Google email, an encrypted Google refresh token, and the proposals you make (with their results, so you can undo them).
Reports and query results are not stored. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>How do I disconnect?</h3>
<p>Sign in at <a href="/account">camberstack.io/account</a> and choose <strong>Disconnect Google Ads</strong>, or remove Camberstack at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. You can also ask your AI to use the <code>disconnect</code>
tool, though some apps (ChatGPT, for one) block disconnect requests from chat.</p>
<h3>What happens after my 3 free changes?</h3>
<p>Diagnosis, proposals, history and undo keep working, free, with no time limit. Applying a fourth change asks you to upgrade:
your AI shows a personal checkout link, and once you've paid you ask it to apply again. Undo is never paywalled.</p>
<h3>Does it work with a manager (MCC) account?</h3>
<p>Yes. It lists the client accounts under any manager your login can reach.</p>
`,
  });
}

/**
 * Use-case page for "claude google ads" / "google ads claude" / "google ads mcp server" (keyword data:
 * project-research/keywords-ads-mcp.json). The worked example is a real find_wasted_spend run on our
 * own account (2026-10-01, 180 days); keep its numbers true to a real run if you edit it.
 */
export function claudeGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-claude",
    title: "Connect Google Ads to Claude: MCP setup in 2 minutes | Camberstack",
    description: "Connect your Google Ads account to Claude with an MCP server. No developer token or Google Cloud project: sign in with Google, then ask Claude what's wasting money.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Claude", url: `${baseUrl}/google-ads-claude`, dateModified: "2026-10-01",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to Claude</h1>
<p class="lede">Claude can read your Google Ads account, tell you where the budget is going with nothing to show for it,
and make the fixes you approve. It takes one connector URL and a Google sign-in. No developer token, no Google Cloud project.</p>

<h2>Set it up</h2>
<p>Camberstack is a hosted Google Ads MCP server. MCP (Model Context Protocol) is how Claude connects to outside tools.</p>
<h3>Claude on the web or desktop app</h3>
<ol>
<li>Open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
<li>Paste the server URL: <code>${mcpUrl}</code></li>
<li>Click <strong>Connect</strong> and sign in with the Google account that has access to your Google Ads.
Google shows exactly what's being shared before you agree.</li>
</ol>
<h3>Claude Code</h3>
<pre>claude mcp add --transport http camberstack ${mcpUrl}</pre>
<p class="muted">Also works in ChatGPT, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>

<h2>What to ask first</h2>
<ul>
<li><em>"What's wasting money in my Google Ads account over the last 90 days?"</em></li>
<li><em>"Is my conversion tracking set up right?"</em></li>
<li><em>"Block the search terms that spent money without converting. Show me the changes first."</em></li>
<li><em>"What did you change this week? Undo the last change."</em></li>
</ul>

<h2>A real example</h2>
<p>We ran it on our own Google Ads account, which runs ads for three products, over 180 days. The account had spent
<strong>$2,080 for 9 conversions</strong> ($231 each). What Claude got back:</p>
<ol>
<li><strong>Tracking first.</strong> Four primary conversion actions, all counting real outcomes (purchases, sign-ups, calls),
so a search term with zero conversions really did produce nothing. If tracking had been broken, it would have said so
before recommending a single cut.</li>
<li><strong>One campaign stood out:</strong> it spent <strong>$1,188 with no conversions</strong>, more than five times
the account's cost per conversion.</li>
<li><strong>Search terms with intent to match:</strong> nine "how to…" searches ("how to create a qr code") cost $56.54
and never converted. Claude suggested <code>"how to"</code> as a phrase negative keyword on that campaign.</li>
<li><strong>Judgment, not a blanket rule.</strong> Searches containing "free" cost $187 across the account, and some of them
<em>did</em> convert. So it suggested blocking "free" only in the two campaigns where it never converted ($87 and $86),
not account-wide.</li>
</ol>
<p>Nothing changed until we said yes. Applying a proposal is a separate step that Claude asks you to approve, and every
applied change can be undone with one more message.</p>

<h2>What it can and can't change</h2>
<p>It can add negative keywords, pause or re-enable a campaign, ad group or keyword, and set a campaign's daily budget.
It can't create campaigns, change bid strategies, or delete anything you built. Turning a campaign back on, or more than
doubling a budget, comes with a warning in the proposal. Every change is first checked with Google as a dry run, shown to
you in plain English, and logged.</p>

<h2>How it compares with Google's own Google Ads MCP</h2>
<p>Google publishes an open-source Google Ads MCP server. As of September 2026 it is <strong>read-only</strong>, and you run it
yourself: you need your own Google Ads API developer token, a Google Cloud project and an OAuth client. That suits developers
who only want reporting. Camberstack is hosted, so you only sign in with Google, and it can <strong>make</strong> the changes
you approve, with undo.</p>

<h2>Questions</h2>
<h3>Do I need a Google Ads developer token?</h3>
<p>No. Camberstack has its own Google Ads API access. You sign in with Google and choose what to share.</p>
<h3>Does Claude see my whole Google account?</h3>
<p>No. It gets Google Ads access and your email address, nothing else: no Gmail, Drive or calendar. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>What does it cost?</h3>
<p>The free plan includes unlimited diagnosis and proposals, change history, undo and 3 applied changes. Pro is $49/month for
unlimited applied changes. See <a href="/#pricing">pricing</a>.</p>
<h3>Does it work with manager (MCC) accounts?</h3>
<p>Yes. It lists every client account your login can reach.</p>

<p><a class="btn" href="/#setup">Connect Google Ads to Claude</a></p>
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
<tr><td>A sign-in session for the account page (a cookie; we store only its hash)</td><td>Keep you signed in to camberstack.io/account</td><td>7 days, or until you sign out</td></tr>
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

<h2>Emails</h2>
<p>We may send you up to two short emails about using Camberstack: one if you connect but don't try it within a couple of days,
and one if you use all your free changes. Each is sent once, from adam@camberstack.io, to the email address of the Google account
you connected. They never contain your Google Ads data. Every email has an unsubscribe link, and replies reach a person.</p>

<h2>Our own Google ads</h2>
<p>If you reach this site by clicking one of our Google ads, we keep the ad click identifier Google adds to the link in a cookie on
this site for up to 90 days. If you then connect Camberstack for the first time, we report that click to our own Google Ads account
as a conversion, so we can tell which ads work. We send only the click identifier and the time: no email, account ID or Google Ads data of yours.</p>

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
There is a free plan and a paid Pro plan, described at <a href="/#pricing">camberstack.io/#pricing</a>.</p>
<h2>Pro subscription</h2>
<p>Pro is billed monthly in advance through Stripe until you cancel. You can cancel any time from the billing link the <code>billing</code> tool gives you; Pro continues until the end of the period you paid for, and we don't refund partial months. If we change the price we will email you at least 30 days before it applies to you.</p>
<h2>You stay in control, and responsible</h2>
<p>Recommendations are generated from your account data and may be wrong. You decide what to approve, and you are responsible
for changes you approve and for your Google Ads spend. Review proposals before approving them.</p>
<h2>Acceptable use</h2>
<p>Use Camberstack only on Google Ads accounts you are authorized to manage, and in line with Google's policies. Don't attempt to access other users' data or overload the service.</p>
<h2>No warranty</h2>
<p>The service is provided "as is", without warranties of any kind, including fitness for a particular purpose or uninterrupted availability.</p>
<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, Camberstack is not liable for indirect or consequential losses, including lost profits or ad spend,
and our total liability is limited to the amount you paid us in the 12 months before the claim (zero if you have only used the free plan).</p>
<h2>Ending</h2>
<p>You can disconnect at any time. We may suspend access that breaks these terms or Google's policies.</p>
<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</div>`,
  });
}

/** A page that brings its own heading (the account page); body is trusted HTML built by the caller. */
export function appPage(baseUrl: string, title: string, path: string, body: string): string {
  return layout({ baseUrl, path, title: `${escapeHtml(title)} | Camberstack`, description: title, body });
}

/** Plain page for billing outcomes; body is trusted HTML built by the caller. */
export function infoPage(baseUrl: string, title: string, body: string): string {
  return layout({ baseUrl, path: "/", title: `${escapeHtml(title)} | Camberstack`, description: title, body: `<h1>${escapeHtml(title)}</h1>${body}` });
}

export function errorPage(baseUrl: string, message: string): string {
  return layout({ baseUrl, path: "/", title: "Connection problem | Camberstack", description: message,
    body: `<h1>That didn't work</h1><p class="lede">${escapeHtml(message)}</p><p><a href="/#setup">Connection instructions</a></p>` });
}

export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nDisallow: /account\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

export function sitemapXml(baseUrl: string, lastmod: string): string {
  const urls = ["/", "/google-ads-claude", "/privacy", "/terms"];
  const lm = lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${baseUrl}${u}</loc>${lm}</url>`).join("\n")}\n</urlset>\n`;
}

export function llmsTxt(baseUrl: string): string {
  return `# Camberstack

> Google Ads MCP server. Connect Google Ads to Claude, ChatGPT or any MCP client; the AI diagnoses wasted spend and applies only changes the user approves.

- MCP endpoint (Streamable HTTP, OAuth 2.1 with dynamic client registration): ${baseUrl}/mcp
- Tools: list_accounts, account_overview, find_wasted_spend, run_gaql, propose_changes, apply_changes, undo_changes, discard_proposal, change_history, billing, disconnect
- Writes are limited to: negative keywords, pause/enable campaign, ad group or keyword, daily budget. Every applied change can be undone.
- Demo: account 000-000-0001 is a sample business (sample data) anyone can try every tool on; changes there never touch Google. Logins with no Google Ads access get it automatically.
- Pricing: Free plan (unlimited diagnosis and proposals, history, undo, 3 applied changes); Pro $49/month for unlimited applied changes. Undo is always free.
- [Setup](${baseUrl}/#setup)
- [Pricing](${baseUrl}/#pricing)
- [Connect Google Ads to Claude (guide with a worked example)](${baseUrl}/google-ads-claude)
- [Source (MIT)](https://github.com/awilliams-2020/camberstack-mcp)
- [Privacy](${baseUrl}/privacy)
- [Terms](${baseUrl}/terms)
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
