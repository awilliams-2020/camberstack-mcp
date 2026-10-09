# Camberstack: a Google Ads MCP server

Connect Google Ads (and, optionally, Search Console) to Claude, ChatGPT, Cursor or any MCP client. Your AI
reads the account with read-only tools and can propose changes, from negative keywords to whole campaigns. **Nothing
changes in the account until you approve a specific proposal, and every applied change can be
undone.**

Hosted: **https://camberstack.io/mcp** (Free: 1 Google Ads account, every tool, unlimited changes; Pro $15/mo: up to 10 accounts). Setup: https://camberstack.io/#setup

## Tools

| tool | writes? | what it does |
|---|---|---|
| `list_accounts` | no | every account the login reaches, including client accounts under a manager (MCC) |
| `account_overview` | no | spend, conversions, cost per conversion per campaign |
| `keyword_ideas` | no | Keyword Planner ideas from seed keywords and/or a URL: monthly searches, competition, top-of-page bid range; marks ideas the account already targets or blocks |
| `keyword_metrics` | no | Keyword Planner numbers for an exact list, with the last 12 months of searches |
| `run_gaql` | no | any read-only GAQL `SELECT` |
| `search_console_sites` | no | the websites (Search Console properties) the login can read |
| `search_console_summary` | no | site-wide clicks, impressions, CTR and position for a window vs. the window before it |
| `search_console_performance` | no | organic clicks, impressions, CTR and position by query, page, country, device or date; text or RE2 regex filters |
| `search_console_trend` | no | a window vs. the one before it, per query and per page: rising, falling, new, lost, and rising searches losing position |
| `search_console_opportunities` | no | queries on positions 4-20 with projected click gain, top-5 queries with weak CTR, question-shaped queries |
| `search_console_inspect_urls` | no | URL Inspection for up to 20 pages: indexed or why not, last crawl, canonical chosen vs declared, structured-data errors |
| `search_console_sitemaps` | no | submitted sitemaps: last downloaded, URL count, errors and warnings |

The Search Console tools take either `days` or exact `start_date`/`end_date`, and `fresh: true` to include the last 2-3
days Google is still filling in. Requesting indexing and submitting sitemaps aren't available: Camberstack only holds
the read-only scope.
| `paid_organic_overlap` | no | joins an Ads account's search terms with a site's organic queries: searches paid for that already rank near the top, and page-2+ searches with no ad |
| `propose_changes` | no | resolves changes against the live account, dry-runs them with Google (`validateOnly`), stores a proposal with a plain-English summary |
| `apply_changes` | **yes** | applies a stored proposal (the user's own, un-applied, under 24h old); records each change's inverse |
| `undo_changes` | no | builds the reversing proposal for an applied one |
| `billing` | no | plan, Google Ads accounts in use (last 30 days) vs. the plan's limit, and a personal upgrade or manage-billing link |
| `discard_proposal`, `change_history`, `disconnect` | | |

What a proposal can do:

- **Control:** add negative keywords; pause or enable a campaign, ad group, keyword or ad; set a campaign's
  daily budget (never a shared budget) or its end date.
- **Build:** create a whole Search campaign (ad groups, keywords, responsive search ads, targeting, negatives,
  sitelinks), always created **paused**; add an ad group, keywords, an ad or sitelinks to an existing campaign.
- **Tune:** keyword and ad group bids, bid strategy, location and language targeting, presence-only location
  mode, final URL suffix.
- **Measure:** create a conversion action, set its counting, scope a campaign to one conversion goal.

Risky changes carry a ⚠ line in the proposal summary: enabling a campaign, more than doubling a budget or a
bid, switching bid strategy, removing the last location, a new primary conversion action. Undo removes only
what Camberstack itself created; nothing the user built is ever deleted. Search Console is read-only.

## How auth works

Camberstack is an OAuth 2.1 authorization server for MCP clients (dynamic client registration,
PKCE). Its `/authorize` sends the user to Google for `adwords` + `openid email`, plus `webmasters.readonly`
(Search Console), which the user may untick: only `adwords` is required. The Google refresh
token is stored AES-256-GCM encrypted and never leaves the server. The MCP client gets
Camberstack's own tokens, which are stored only as SHA-256 hashes.

Two MCP SDKs, on purpose: `/mcp` is served by SDK v2 (`@modelcontextprotocol/server` + `/node`), which
answers both 2026-07-28 clients (`server/discover`) and 2025-era ones (`initialize`, kept on a
JSON-response transport). The authorization server (`mcpAuthRouter`, `requireBearerAuth`) stays on
`@modelcontextprotocol/sdk` 1.x, because v2 ships only the resource-server half. Don't drop 1.x
until v2 (or a companion package) has `/authorize`, `/token` and `/register`.

## Run it

```bash
npm ci && npm test
ENCRYPTION_KEY=$(openssl rand -hex 32) \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_ADS_DEVELOPER_TOKEN=… \
BASE_URL=https://your.host npm run dev
```

| env | |
|---|---|
| `ENCRYPTION_KEY` | 32 bytes, hex or base64. **Losing it only forces users to reconnect**; leaking it exposes stored Google tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client from a **dedicated** Google Cloud project with Google Ads API access. Redirect URI: `<BASE_URL>/oauth/google/callback`. Unset = pages only, sign-in reports "not open yet" |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | sent when set |
| `BASE_URL` | public origin, the OAuth issuer (default `https://camberstack.io`) |
| `DATA_DIR` | SQLite location (default `./data`) |
| `FREE_ACCOUNTS` / `PRO_ACCOUNTS` / `PRO_EMAILS` | Google Ads accounts each plan covers, counted as distinct accounts used in the last 30 days, manager and demo accounts excluded (defaults 1 / 10) / emails treated as Pro |
| `STRIPE_SECRET_KEY` / `STRIPE_PRO_PRICE_ID` | Pro subscription via Stripe Checkout; unset = no upgrade links |

`scripts/try-account.ts` runs the read tools against a real account from an existing refresh
token, skipping OAuth. Use it for dogfooding.

## License

MIT
