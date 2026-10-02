/**
 * The public pages. The homepage and privacy policy double as what Google's brand verification
 * reviews: they must name the app, say what it does with Google user data, and link the policy.
 */

import { z } from "zod";
import { PRO_SESSION } from "./plans.js";
import type { ToolDoc } from "./tools.js";

const CONTACT = "adam@camberstack.io";
const UPDATED = "2026-10-01";

const CSS = `
.linkish{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}
@font-face{font-family:"IBM Plex Sans";font-weight:400;font-display:swap;src:url(/fonts/ibm-plex-sans-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Sans";font-weight:600;font-display:swap;src:url(/fonts/ibm-plex-sans-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
:root{--bg:#fff;--fg:#17181a;--muted:#5b5f66;--line:#e3e4e6;--card:#f8f8f9;--accent:#1f5f4a;--accent-fg:#fff;--code:#f1f2f3}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#e9eaec;--muted:#a0a4ab;--line:#2a2c30;--card:#17181b;--accent:#6fc4a4;--accent-fg:#0d1f19;--code:#1e2023}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1,h2,h3,strong,b,th{font-weight:600}
.wrap{max-width:860px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line)}header .wrap{display:flex;justify-content:space-between;align-items:center;height:60px}
.brand{white-space:nowrap;font-weight:600;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:15px}nav a:hover{color:var(--fg)}
h1{font-size:clamp(30px,5vw,44px);line-height:1.15;text-wrap:balance;letter-spacing:-.02em;margin:56px 0 16px}
h2{font-size:24px;letter-spacing:-.01em;margin:56px 0 12px}h3{font-size:18px;margin:24px 0 6px}
p,li{color:var(--fg)}.lede{font-size:20px;color:var(--muted);max-width:680px}
.muted{color:var(--muted)}a{color:var(--accent)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.card h3{margin-top:0}
code,pre{font:14px/1.5 "IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:2px 5px}pre{padding:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.convo{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:24px}
.convo p{margin:8px 0}.who{font-weight:600;color:var(--muted);font-size:14px;margin:16px 0 4px!important}.convo .who:first-child{margin-top:0!important}
.convo .said{display:inline-block;background:var(--code);border-radius:12px;padding:8px 14px;margin-top:0}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
footer{border-top:1px solid var(--line);margin-top:72px;padding:28px 0;font-size:14px;color:var(--muted)}
footer a{color:var(--muted);margin-right:16px}
.legal h2{font-size:20px;margin-top:36px}
ol.steps>li{margin-bottom:28px}
.shot{display:block;width:100%;max-width:340px;height:auto;margin-top:12px;border:1px solid var(--line);border-radius:12px}
.url{display:flex;align-items:center;gap:10px;background:var(--code);border-radius:8px;padding:8px 8px 8px 14px;margin:8px 0 24px}
.url code{background:none;padding:0;flex:1;font-size:15px;overflow-x:auto;white-space:nowrap}
.cmd{display:flex;align-items:flex-start;gap:10px;background:var(--code);border-radius:8px;padding:8px 8px 8px 14px;margin:8px 0 16px}
.cmd pre{background:none;padding:4px 0;margin:0;flex:1}
.acct{padding:32px 0 8px}
.acct-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:20px}
.acct-head h1{font-size:28px;margin:0}.acct-head .who{text-transform:none;letter-spacing:0;font-weight:400;font-size:15px}
.acct h2{font-size:19px;margin:36px 0 12px}
.acct .grid{margin-top:0}.acct .card{display:flex;flex-direction:column;gap:10px}
.label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0}
.big{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:0}
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
.pill.ro{background:color-mix(in srgb,#2f9e6e 16%,transparent);color:#2f9e6e}
.pill.prep{background:color-mix(in srgb,#c78a12 18%,transparent);color:#b07a10}
.pill.act{background:color-mix(in srgb,#c2412d 16%,transparent);color:#c2412d}
.tool{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:12px;scroll-margin-top:16px}
.tool h3{margin:0;font-size:18px}.tool p{margin:8px 0 0}.tool table{margin-top:10px;font-size:14px}.tool td:first-child{white-space:nowrap}
.danger{border:1px solid color-mix(in srgb,#c2412d 40%,var(--line));border-radius:10px;padding:16px}
.danger p{margin:0 0 12px}.danger label{display:block;margin-bottom:12px}
.btn-danger{font:inherit;font-weight:600;background:#c2412d;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
.signin{max-width:440px;margin:72px auto 96px;text-align:center}.signin .card{display:flex;flex-direction:column;gap:16px;align-items:center;padding:36px 32px}.signin .btn{align-self:center}
@media (max-width:600px){
nav a{margin-left:12px}
.btn{padding:9px 14px;font-size:15px;border-radius:7px}
.btn-danger{padding:9px 14px;font-size:15px}
.signin{margin:40px auto 56px}.signin .card{padding:28px 20px}
.big{font-size:22px}
}
`;

export const SOURCE_URL = "https://github.com/awilliams-2020/camberstack-mcp";

function layout(o: { title: string; description: string; path: string; body: string; baseUrl: string; jsonLd?: object; noindex?: boolean }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${o.baseUrl}${o.path}">${o.noindex ? '\n<meta name="robots" content="noindex">' : ""}
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
<a href="/tools">Tools</a><a href="${SOURCE_URL}">Source code (MIT)</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a><a href="mailto:${CONTACT}">${CONTACT}</a>
<p>Camberstack is independent and not affiliated with or endorsed by Google. Google Ads is a trademark of Google LLC.</p>
</div></footer>
<script src="/e.js" defer></script>
</body></html>`;
}

/** Copies a [data-copy] button's text to the clipboard. Include once per page. */
export const COPY_JS = `<script>document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b||!navigator.clipboard)return;
navigator.clipboard.writeText(b.dataset.copy).then(function(){var t=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=t},1500)})});</script>`;

/** A command or config line with a Copy button; needs COPY_JS on the page. */
export function cmd(text: string): string {
  return `<div class="cmd"><pre>${esc(text)}</pre><button class="copy" type="button" data-copy="${esc(text)}">Copy</button></div>`;
}

/** A guide screenshot from brand/shots/ (served at /shots/). */
const shot = (file: string, w: number, h: number, alt: string) =>
  `<img class="shot" src="/shots/${file}" width="${w}" height="${h}" alt="${alt}" loading="lazy">`;

export function homePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/",
    title: "Camberstack: hosted Google Ads MCP for Claude and ChatGPT",
    description: "A hosted Google Ads MCP server. Connect Google Ads to Claude, ChatGPT or Cursor with a Google sign-in: no developer token or Google Cloud project. Read your account, and make a small set of changes you approve, with undo.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Camberstack",
      applicationCategory: "BusinessApplication", operatingSystem: "Web", url: baseUrl,
      description: "Hosted Google Ads MCP server for Claude, ChatGPT and other MCP apps: read-only queries, a waste check, and a small set of approved changes with undo.",
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD",
          description: "Unlimited diagnosis and proposals, change history and undo, plus 3 applied changes." },
        { "@type": "Offer", name: "Pro", price: "49", priceCurrency: "USD", description: `Unlimited applied changes, plus ${PRO_SESSION}.`,
          priceSpecification: { "@type": "UnitPriceSpecification", price: "49", priceCurrency: "USD", billingDuration: "P1M", unitCode: "MON" } },
      ],
    },
    body: `
<h1>A hosted Google Ads MCP server</h1>
<p class="lede">Connect your Google Ads account to Claude, ChatGPT, Cursor or any MCP app with one URL and a Google sign-in.
No developer token, no Google Cloud project, nothing to install. Your AI can read the account, and can make a short list of
changes, each one only after you approve it.</p>
<ul>
<li>Works with manager (MCC) accounts.</li>
<li>Any question about your account is answered with read-only queries.</li>
<li>Changes are limited to negative keywords, pausing or re-enabling, and daily budgets. Each applied change can be undone.</li>
</ul>
<p><a class="btn" href="#setup">Connect</a> <span class="muted">&nbsp;Free plan, no card</span></p>

<h2>Built-in waste check</h2>
<p>Ask "what's wasting money?" and the <code>find_wasted_spend</code> tool checks, in order (see <a href="/google-ads-claude">a run on our own account</a>):</p>
<ol>
<li>Conversion tracking. With no primary conversion action, or a page view counted as a conversion, every other number is misleading, so it tells you that first.</li>
<li>Search terms that cost more than a conversion usually does and didn't convert. Your own cost per conversion sets the bar.</li>
<li>Low-intent searches like "free", "jobs", "how to" and "login", but only where they've never converted for you.</li>
<li>Keywords that spent twice your cost per conversion and never converted.</li>
</ol>

<h2 id="changes">What it can change</h2>
<table>
<tr><th>Change</th><th>Undo</th></tr>
<tr><td>Add negative keywords to a campaign</td><td>Removes exactly the negatives it added</td></tr>
<tr><td>Pause or re-enable a campaign, ad group or keyword</td><td>Restores the previous status</td></tr>
<tr><td>Change a campaign's daily budget (not shared budgets)</td><td>Restores the previous amount</td></tr>
</table>
<p class="muted">Turning a campaign back on, or more than doubling a budget, is flagged with a warning in the proposal before you approve it.
It cannot create or delete campaigns, change bid strategies, touch billing, or edit anything outside Google Ads.
Any question beyond these tools is answered with read-only queries. <a href="/tools">Every tool and what it can do</a>;
the code is <a href="${SOURCE_URL}">open source</a>.</p>

<h2 id="setup">Connect</h2>
<p>Add this server URL to your AI app, then sign in with Google.</p>
<div class="url"><code>${mcpUrl}</code><button class="copy" type="button" data-copy="${mcpUrl}">Copy</button></div>
${COPY_JS}
<h3>Claude (web and desktop app)</h3>
<p>Add it as a custom connector in <strong>Settings</strong>, under <strong>Connectors</strong>. About two minutes.
<a href="/google-ads-claude">Setup guide with screenshots</a></p>
<h3>ChatGPT (Plus, Pro, Business, Enterprise)</h3>
<p>Turn on developer mode, add it as an MCP app, then type <strong>@Camberstack</strong> in a chat.
<a href="/google-ads-chatgpt">Step-by-step setup guide</a></p>
<h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}
<h3>Cursor, VS Code, others</h3>
${cmd(`{ "mcpServers": { "camberstack": { "url": "${mcpUrl}" } } }`)}
<p class="muted">Your AI app handles sign-in. Google will show "Camberstack wants to access your Google Ads" before anything is shared.</p>
<h3>Want to look first?</h3>
<p>Connect, then ask <em>"Show me Camberstack's demo account"</em>. It's a sample plumbing business with six months of
campaigns and search terms, so you can try diagnosis, proposals, applying and undo without touching a real account.
Changes there never reach Google and don't use your free changes. A Google login with no Google Ads access gets the demo automatically.</p>

<h2 id="pricing">Pricing</h2>
<div class="grid">
<div class="card"><h3>Free</h3><p>Unlimited diagnosis and proposals, change history and undo, plus <strong>3 applied changes</strong>. No card.</p>
<p><a class="btn" href="#setup">Connect for free</a></p></div>
<div class="card"><h3>Pro: $49/month</h3><p>Everything in Free, with <strong>unlimited applied changes</strong>, plus ${PRO_SESSION}. Cancel any time; you keep Pro until the end of the month you paid for.</p>
<p><a class="btn" href="/account?upgrade=1">Upgrade to Pro</a></p><p class="muted" style="font-size:14px">Connect Camberstack to your AI app first; you'll sign in with the same Google account.</p></div>
</div>

<h2>Questions</h2>
<h3>Can the AI change my account without asking?</h3>
<p>Not without a proposal. Every change is first stored as a proposal and checked with Google; applying it is a separate
tool call, and the server refuses anything that wasn't proposed first, is older than 24 hours, or belongs to someone else.
Claude and ChatGPT normally ask you before running a tool that changes things, but if you've set that tool to "always allow",
the AI could propose and apply in one go. Keep the confirmation on for <code>apply_changes</code>.</p>
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

// ---------------------------------------------------------------- shared by the setup guides

const ASK_FIRST = `<h2>What to ask first</h2>
<ul>
<li><em>"What's wasting money in my Google Ads account over the last 90 days?"</em></li>
<li><em>"Is my conversion tracking set up right?"</em></li>
<li><em>"Block the search terms that spent money without converting. Show me the changes first."</em></li>
<li><em>"What did you change this week? Undo the last change."</em></li>
<li>Not ready to use your real account? <em>"Show me Camberstack's demo account."</em></li>
</ul>`;

const CAN_CHANGE = `<h2>What it can change</h2>
<p>Negative keywords, paused or enabled campaigns, ad groups and keywords, and daily budgets. You approve each change, and each
one can be undone. <a href="/#changes">The full list</a>, and <a href="/tools">every tool</a>.</p>`;

/** The questions every guide answers; `app` is the AI app's name. */
const commonQuestions = (app: string) => `<h3>Do I need a Google Ads developer token?</h3>
<p>No. Camberstack has its own Google Ads API access. You sign in with Google and choose what to share.</p>
<h3>Does ${app} see my whole Google account?</h3>
<p>No. It gets Google Ads access and your email address, nothing else: no Gmail, Drive or calendar. Details in the <a href="/privacy">privacy policy</a>.</p>
<h3>What does it cost?</h3>
<p>Free for diagnosis, proposals and undo, with 3 applied changes. <a href="/#pricing">Pro</a> is $49/month.</p>`;

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
      headline: "Connect Google Ads to Claude", url: `${baseUrl}/google-ads-claude`, dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to Claude</h1>
<p class="lede">Claude can read your Google Ads account, find the spend that never converted,
and make the fixes you approve. It takes one connector URL and a Google sign-in. No developer token, no Google Cloud project.</p>

<h2>Set it up</h2>
<p>Camberstack is a hosted Google Ads MCP server. MCP (Model Context Protocol) is how Claude connects to outside tools.</p>
<h3>Claude on the web or desktop app</h3>
<ol class="steps">
<li>Click your name at the bottom of the sidebar and choose <strong>Settings</strong>.
${shot("claude-1.webp", 540, 546, "Claude's account menu, open over the sidebar, with Settings highlighted")}</li>
<li>Open the <strong>Connectors</strong> tab and click <strong>Add</strong>.
${shot("claude-2.webp", 540, 643, "Claude's Settings on the Connectors tab, with the Add button highlighted")}</li>
<li>Choose <strong>Add custom connector</strong>.
${shot("claude-3.webp", 540, 423, "The Add menu with Add custom connector highlighted")}</li>
<li>Name it Camberstack, paste the server URL <code>${mcpUrl}</code> and click <strong>Continue</strong>.
${shot("claude-4.webp", 540, 885, "The Add custom connector form, with the Name and MCP server URL fields highlighted")}</li>
<li>Sign in with the Google account that has access to your Google Ads.
Google shows exactly what's being shared before you agree.</li>
<li>In a chat, click <strong>+</strong> at the bottom left, open <strong>Connectors</strong> and make sure Camberstack is switched on.</li>
</ol>
<p class="muted">On the Free plan you can add one custom connector. On a Team or Enterprise plan, an Owner adds it first in
<strong>Organization settings</strong>, under <strong>Connectors</strong> (choose Add, Custom, then Web); then each member connects it from their own Settings.</p>
<h3>Claude Code</h3>
${cmd(`claude mcp add --transport http camberstack ${mcpUrl}`)}
${COPY_JS}
<p class="muted">Also works in <a href="/google-ads-chatgpt">ChatGPT</a>, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>

${ASK_FIRST}

<h2>A real example</h2>
<p>We ran it on our own Google Ads account, which runs ads for three products, over 180 days. The account had spent
<strong>$2,080 for 9 conversions</strong> ($231 each). What Claude came back with:</p>
<ol>
<li>It checked tracking before anything else. All four primary conversion actions counted real outcomes (purchases,
sign-ups, calls), so a search term with no conversions really had produced nothing.</li>
<li>One campaign had spent <strong>$1,188 with no conversions</strong>, more than five times the account's cost per conversion.</li>
<li>Nine "how to…" searches, such as "how to create a qr code", had cost $56.54 without converting. Claude suggested
<code>"how to"</code> as a phrase negative keyword on that campaign.</li>
<li>Searches containing "free" cost $187 across the account, but some of them converted. So Claude suggested blocking
"free" only in the two campaigns where it never had ($87 and $86).</li>
</ol>
<p>Nothing changed until we approved it.</p>

${CAN_CHANGE}

<h2>How it compares with Google's own Google Ads MCP</h2>
<p>Google publishes an open-source Google Ads MCP server. As of September 2026 it is <strong>read-only</strong>, and you run it
yourself: you need your own Google Ads API developer token, a Google Cloud project and an OAuth client. That suits developers
who only want reporting. Camberstack is hosted, so you only sign in with Google, and it can <strong>make</strong> the changes
you approve, with undo.</p>

<h2>Questions</h2>
${commonQuestions("Claude")}

<p><a class="btn" href="/#setup">Connect Google Ads to Claude</a></p>
`,
  });
}

/**
 * Use-case page for "chatgpt google ads". ChatGPT only takes plugins outside its directory through developer
 * mode, which is several menus deep and warns that "custom MCP servers introduce risk", so this page walks through both.
 * Menu labels, the OAuth option, @-mention use and mobile confirmed by the operator in a live account, 2026-10-01; the Plugins path
 * (+, Create custom MCP server, Create MCP App) re-confirmed with screenshots 2026-10-02. Developer mode IS required: with it off,
 * Create custom MCP server is not offered (operator, 2026-10-02). They move, so re-check when editing.
 */
export function chatgptGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-chatgpt",
    title: "Connect Google Ads to ChatGPT: MCP setup, step by step | Camberstack",
    description: "Connect your Google Ads account to ChatGPT with a plugin. No developer token or Google Cloud project: turn on developer mode, add one URL, sign in with Google, then ask what's wasting money.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to ChatGPT", url: `${baseUrl}/google-ads-chatgpt`, dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to ChatGPT</h1>
<p class="lede">ChatGPT can read your Google Ads account, find the spend that never converted,
and make the fixes you approve. Setup takes a few menus in ChatGPT's settings and a Google sign-in. No developer token,
no Google Cloud project.</p>

<h2>Before you start</h2>
<ul>
<li><strong>A paid ChatGPT plan:</strong> Plus, Pro, Business, Enterprise or Edu. The free plan can't add plugins like this one.</li>
<li><strong>ChatGPT on the web</strong> (chatgpt.com) for setup. Once it's added, it works in the ChatGPT phone app too.</li>
<li><strong>On Business or Enterprise,</strong> a workspace admin may need to allow developer mode first, under
<strong>Workspace settings</strong>, under <strong>Permissions &amp; roles</strong>.</li>
</ul>

<h2>Set it up</h2>
<ol>
<li>In ChatGPT, click your name at the bottom of the sidebar and choose <strong>Settings</strong>.
${shot("chatgpt-dev-1.webp", 540, 521, "ChatGPT's account menu with Settings highlighted")}</li>
<li>Open the <strong>Plugins</strong> tab and choose <strong>Developer mode</strong>.
${shot("chatgpt-dev-2.webp", 540, 809, "ChatGPT's Settings on the Plugins tab, with Developer mode highlighted")}</li>
<li>Turn on the <strong>Developer mode</strong> switch.
${shot("chatgpt-dev-3.webp", 540, 612, "The Developer mode switch, marked Elevated risk")}</li>
<li>Open <strong>Plugins</strong> from the sidebar.
${shot("chatgpt-1.webp", 540, 497, "ChatGPT's sidebar with Plugins highlighted")}</li>
<li>Click <strong>+</strong> next to the search box and choose <strong>Create custom MCP server</strong>.
${shot("chatgpt-2.webp", 540, 503, "ChatGPT's Plugins page with the + button and Create custom MCP server highlighted")}</li>
<li>Click <strong>Create MCP App</strong>.
${shot("chatgpt-3.webp", 540, 582, "The New Plugin dialog with Create MCP App highlighted")}</li>
<li>Name it Camberstack, paste the server URL <code>${mcpUrl}</code> under <strong>Connection</strong>, leave
<strong>Authentication</strong> on <strong>OAuth</strong>, and tick <strong>I understand and want to continue</strong>.
${shot("chatgpt-4.webp", 540, 994, "ChatGPT's New Plugin form with the Name, server URL, Authentication and I understand checkbox highlighted")}</li>
<li>Sign in with the Google account that has access to your Google Ads. Google shows exactly what's being shared before you agree.</li>
<li>In a chat, type <strong>@</strong> and the name you gave it, then your question:
<em>"@Camberstack what's wasting money in my Google Ads account?"</em></li>
</ol>

<h2>About the "Custom MCP servers introduce risk" warning</h2>
<p>ChatGPT shows that warning for every custom MCP server, which is the only way to add one that isn't in
ChatGPT's plugin directory yet. It isn't specific to Camberstack. What protects your account here:</p>
<ul>
<li>Changes are stored as a proposal and checked with Google first; applying is a separate tool call. ChatGPT asks you to
confirm tool calls that change things unless you've turned that off.</li>
<li>Every applied change can be undone with one more message.</li>
<li>Changes are limited to negative keywords, pausing or re-enabling, and daily budgets. Nothing can be deleted.</li>
</ul>

${ASK_FIRST}

${CAN_CHANGE}

<h2>Questions</h2>
<h3>Why does it take so many steps?</h3>
<p>Until Camberstack is listed in ChatGPT's plugin directory, developer mode is how ChatGPT lets you add it. You only do it once.
If you use Claude too, setup there is shorter: see <a href="/google-ads-claude">the Claude guide</a>.</p>
<h3>How do I disconnect?</h3>
<p>ChatGPT blocks disconnect requests from chat, so sign in at <a href="/account">camberstack.io/account</a> and choose
<strong>Disconnect Google Ads</strong>, or remove Camberstack at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
${commonQuestions("ChatGPT")}

<p><a class="btn" href="/#setup">Connect Google Ads to ChatGPT</a></p>
`,
  });
}

/**
 * Use-case page for "gemini google ads". Gemini takes outside MCP servers as "custom apps" (Gemini Spark), which
 * Google limits to personal accounts, 18+, in the US, with Keep Activity on, on a Google AI Pro or Ultra plan
 * (support.google.com/gemini/answer/17209137, read 2026-10-02). Screenshots are the operator's, mobile web, 2026-10-02; the path (Settings, Personal Intelligence,
 * Connected Apps, Custom apps) confirmed by the operator the same day.
 * Gemini supports dynamic client registration, so Additional settings stays closed.
 * NOT WORKING as of 2026-10-02: Gemini registers and the user signs in, but Gemini never calls /token (code issued, never
 * redeemed; same with Google sign-in bypassed). Page is noindex and unlinked until it does. Reported to Google:
 * https://discuss.ai.google.dev/t/186405 (and in-app feedback). Same bug open since 2026-08-06, reproduced there with static
 * (non-DCR) credentials, no Google fix as of 2026-10-02: https://discuss.ai.google.dev/t/177327. Re-list it in homePage,
 * sitemapXml and llmsTxt when fixed.
 */
export function geminiGuidePage(baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  return layout({
    baseUrl, path: "/google-ads-gemini", noindex: true,
    title: "Connect Google Ads to Gemini: custom app (MCP) setup | Camberstack",
    description: "Connect your Google Ads account to Google Gemini as a custom app. No developer token or Google Cloud project: add one URL, sign in with Google, then ask Gemini what's wasting money.",
    jsonLd: {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: "Connect Google Ads to Gemini", url: `${baseUrl}/google-ads-gemini`, dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "Camberstack", url: baseUrl },
      about: { "@type": "SoftwareApplication", name: "Camberstack", url: baseUrl },
    },
    body: `
<h1>Connect Google Ads to Gemini</h1>
<div class="card"><p><strong>Not working yet.</strong> Gemini accepts Camberstack and you can sign in, but Gemini then stops
before finishing the connection, with "Cannot Complete Request". We've reported it to Google. Until it's fixed, use
<a href="/google-ads-claude">Claude</a> or <a href="/google-ads-chatgpt">ChatGPT</a>. The steps below are kept for when it works.</p></div>
<p class="lede">Gemini can read your Google Ads account, find the spend that never converted,
and make the fixes you approve. You add Camberstack as a custom app with one URL, then sign in with Google.
No developer token, no Google Cloud project.</p>

<h2>Before you start</h2>
<p>Google only offers custom apps in Gemini when all of these are true. If the <strong>Custom apps</strong> option is missing, one of them is why.</p>
<ul>
<li><strong>A personal Google account.</strong> Work and school (Google Workspace) accounts don't get custom apps.</li>
<li><strong>Google AI Pro or Ultra</strong>, the plans that include Gemini Spark.</li>
<li><strong>18 or over, in the US,</strong> with Gemini set to English.</li>
<li><strong>Keep Activity turned on</strong> in Gemini's activity settings. Custom apps are switched off without it.</li>
</ul>

<h2>Set it up</h2>
<ol>
<li>In Gemini, open <strong>Settings</strong> and choose <strong>Personal Intelligence</strong>.
${shot("gemini-menu.webp", 540, 285, "Gemini's settings menu with Personal Intelligence highlighted")}</li>
<li>Tap <strong>Connected Apps</strong>.
(Shortcut: <a href="https://gemini.google.com/apps">gemini.google.com/apps</a> opens it directly.)
${shot("gemini-connected.webp", 540, 299, "Gemini's Personal Intelligence page with the Connected Apps card highlighted")}</li>
<li>Tap <strong>Custom apps</strong>.
${shot("gemini-1.webp", 540, 334, "Gemini's Connected Apps page with the Custom apps filter highlighted")}</li>
<li>Under <strong>Custom apps for Spark</strong>, paste the server URL <code>${mcpUrl}</code> and tap <strong>Next</strong>.
${shot("gemini-2.webp", 540, 218, "The Custom apps for Spark box, with the app link field and Next button highlighted")}</li>
<li>In <strong>Connect to an MCP server</strong>, check the URL is <code>${mcpUrl}</code> and tap <strong>Next</strong>.
Leave <strong>Additional settings</strong> alone: Camberstack registers itself with Gemini, so there's no client ID or secret to enter.
${shot("gemini-3.webp", 540, 655, "Gemini's Connect to an MCP server dialog, with the MCP Server URL field and Next button highlighted")}</li>
<li>Sign in with the Google account that has access to your Google Ads. Google shows exactly what's being shared before you agree.
It can be a different Google account from the one you use Gemini with.</li>
<li>Start a new chat and ask your question. Gemini uses Camberstack when the question is about your Google Ads.</li>
</ol>
<p class="muted">Setup works on the Gemini website on a computer or phone. Once it's added, it's there in the Gemini app too.</p>

${ASK_FIRST}

${CAN_CHANGE}

<h2>Questions</h2>
<h3>Why does Gemini say the app "hasn't been reviewed by Google"?</h3>
<p>Gemini shows that for every custom app. It isn't specific to Camberstack. Nothing in your account changes until you approve
a specific proposal, every applied change can be undone, and nothing can be deleted.</p>
<h3>Isn't Gemini already connected to my Google account?</h3>
<p>Gemini's built-in Google apps don't include Google Ads. Camberstack adds it, with its own Google sign-in limited to Google Ads and your email address.</p>
${commonQuestions("Gemini")}

<p class="muted">Also works in <a href="/google-ads-claude">Claude</a>, <a href="/google-ads-chatgpt">ChatGPT</a>, Cursor and other MCP apps: see <a href="/#setup">all setup options</a>.</p>
<p><a class="btn" href="/#setup">Connect Google Ads to Gemini</a></p>
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
<p>We count visits to this website's pages with Matomo, which we host ourselves on the same infrastructure. A small script served from this site sends the page you opened, the site that linked you here, and the name of the ad or campaign that brought you, if any (never the ad's click identifier); we also record that a Google Ads account was connected, with no account, email or ID attached. It sets no cookie and stores nothing in your browser. Matomo uses your IP address to estimate roughly where a visit came from and removes the last part of it before saving. Visits are grouped by a salted hash of your IP address and browser, with the salt changed daily and kept only in memory, so it cannot identify you or link visits across days. None of your Google data is sent to analytics, and we use no third-party analytics or advertising scripts.</p>

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
  return layout({ baseUrl, path, title: `${esc(title)} | Camberstack`, description: title, body });
}

/** Plain page for billing outcomes; body is trusted HTML built by the caller. */
export function infoPage(baseUrl: string, title: string, body: string): string {
  return layout({ baseUrl, path: "/", title: `${esc(title)} | Camberstack`, description: title, body: `<h1>${esc(title)}</h1>${body}` });
}

export function errorPage(baseUrl: string, message: string): string {
  return layout({ baseUrl, path: "/", title: "Connection problem | Camberstack", description: message,
    body: `<h1>That didn't work</h1><p class="lede">${esc(message)}</p><p><a href="/#setup">Connection instructions</a></p>` });
}

/** What a tool can do to the account, from its MCP annotations. */
function effect(t: ToolDoc): { cls: string; label: string } {
  if (t.annotations.readOnlyHint) return { cls: "ro", label: "Read-only" };
  if (t.annotations.destructiveHint) return { cls: "act", label: "Needs your go-ahead" };
  return { cls: "prep", label: "Changes nothing in Google Ads" };
}

/** /tools: generated from the registered tool definitions, so it can't drift from what the server offers. */
export function toolsPage(baseUrl: string, tools: ToolDoc[]): string {
  const params = (t: ToolDoc) => {
    if (!t.inputSchema || !Object.keys(t.inputSchema).length) return "";
    const js = z.toJSONSchema(z.object(t.inputSchema), { io: "input", unrepresentable: "any" }) as
      { properties: Record<string, { description?: string; default?: unknown }>; required?: string[] };
    const rows = Object.entries(js.properties).map(([name, p]) => {
      const note = p.default !== undefined ? `Default ${esc(JSON.stringify(p.default))}.`
        : js.required?.includes(name) ? "Required." : "Optional.";
      return `<tr><td><code>${esc(name)}</code></td><td>${esc(p.description ?? "")} <span class="muted">${note}</span></td></tr>`;
    });
    return `<table><tr><th>Parameter</th><th>What it is</th></tr>${rows.join("")}</table>`;
  };
  const cards = tools.map((t) => {
    const e = effect(t);
    return `<div class="tool" id="${esc(t.name)}"><div class="change-top"><h3><code>${esc(t.name)}</code> ${esc(t.title)}</h3>
<span class="pill ${e.cls}">${e.label}</span></div><p>${esc(t.description)}</p>${params(t)}</div>`;
  }).join("\n");
  return layout({
    baseUrl, path: "/tools",
    title: "Camberstack tools: every Google Ads MCP tool and parameter",
    description: `The ${tools.length} tools your AI gets when you connect Camberstack to Google Ads: what each reads, what it can change, and its parameters.`,
    body: `
<h1>Every Camberstack tool</h1>
<p class="lede">These are the ${tools.length} tools your AI assistant gets when you connect Camberstack. This page is built from the
same definitions the server uses, so it always matches what's live, and the descriptions are the ones your AI reads. The code is open source: <a href="${SOURCE_URL}">read it on GitHub</a>.</p>
<p><span class="pill ro">Read-only</span> tools never change anything. <span class="pill prep">Changes nothing in Google Ads</span>
tools prepare or manage proposals. Only <code>apply_changes</code> edits your ads, and only after you approve a specific proposal.
<code>disconnect</code> asks you to confirm before it revokes access.</p>
${cards}
<p class="muted">You don't call these yourself: ask your AI in plain English and it picks the tools. <a href="/#setup">Connect Camberstack</a>.</p>`,
  });
}

export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nDisallow: /account\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

export function sitemapXml(baseUrl: string, lastmod: string): string {
  const urls = ["/", "/google-ads-claude", "/google-ads-chatgpt", "/tools", "/privacy", "/terms"];
  const lm = lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${baseUrl}${u}</loc>${lm}</url>`).join("\n")}\n</urlset>\n`;
}

export function llmsTxt(baseUrl: string, tools: ToolDoc[]): string {
  return `# Camberstack

> Google Ads MCP server. Connect Google Ads to Claude, ChatGPT or any MCP client; the AI diagnoses wasted spend and applies only changes the user approves.

- MCP endpoint (Streamable HTTP, OAuth 2.1 with dynamic client registration): ${baseUrl}/mcp
- Tools: ${tools.map((t) => t.name).join(", ")}
- Writes are limited to: negative keywords, pause/enable campaign, ad group or keyword, daily budget. Every applied change can be undone.
- Demo: account 000-000-0001 is a sample business (sample data) anyone can try every tool on; changes there never touch Google. Logins with no Google Ads access get it automatically.
- Pricing: Free plan (unlimited diagnosis and proposals, history, undo, 3 applied changes); Pro $49/month for unlimited applied changes plus a 30-minute call or written review of the account's ads with the founder. Undo is always free.
- [Setup](${baseUrl}/#setup)
- [Pricing](${baseUrl}/#pricing)
- [Connect Google Ads to Claude (guide with a worked example)](${baseUrl}/google-ads-claude)
- [Connect Google Ads to ChatGPT (step-by-step guide)](${baseUrl}/google-ads-chatgpt)
- [Every tool, with its parameters](${baseUrl}/tools)
- [Source (MIT)](${SOURCE_URL})
- [Privacy](${baseUrl}/privacy)
- [Terms](${baseUrl}/terms)
`;
}

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
