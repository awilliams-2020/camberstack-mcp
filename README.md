# Camberstack: a Google Ads MCP server

Connect Google Ads to Claude, ChatGPT, Cursor or any MCP client. Your AI reads the account with
read-only tools and can propose a small set of changes. **Nothing
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
| `propose_changes` | no | resolves changes against the live account, dry-runs them with Google (`validateOnly`), stores a proposal with a plain-English summary |
| `apply_changes` | **yes** | applies a stored proposal (the user's own, un-applied, under 24h old); records each change's inverse |
| `undo_changes` | no | builds the reversing proposal for an applied one |
| `billing` | no | plan, Google Ads accounts in use (last 30 days) vs. the plan's limit, and a personal upgrade or manage-billing link |
| `discard_proposal`, `change_history`, `disconnect` | | |

Writes are limited to: add negative keywords, pause/enable a campaign, ad group or keyword, set a
campaign's daily budget (never a shared budget) or its end date. Enabling a campaign and more-than-doubling a budget
carry a ⚠ line in the proposal summary. No campaign creation, bid strategy changes or deletions of
anything the user built.

## How auth works

Camberstack is an OAuth 2.1 authorization server for MCP clients (dynamic client registration,
PKCE). Its `/authorize` sends the user to Google for `adwords` + `openid email`. The Google refresh
token is stored AES-256-GCM encrypted and never leaves the server. The MCP client gets
Camberstack's own tokens, which are stored only as SHA-256 hashes.

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
