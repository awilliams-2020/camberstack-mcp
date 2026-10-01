# Camberstack: a Google Ads MCP server that acts

Connect Google Ads to Claude, ChatGPT, Cursor or any MCP client. Your AI checks conversion
tracking, finds where the budget goes with nothing to show for it, and proposes fixes. **Nothing
changes in the account until you approve a specific proposal, and every applied change can be
undone.**

Hosted: **https://camberstack.io/mcp** (free plan: unlimited diagnosis + 3 applied changes; Pro $49/mo unlimited). Setup: https://camberstack.io/#setup

## Tools

| tool | writes? | what it does |
|---|---|---|
| `list_accounts` | no | every account the login reaches, including client accounts under a manager (MCC) |
| `account_overview` | no | spend, conversions, cost per conversion per campaign |
| `find_wasted_spend` | no | tracking check → campaigns with no conversions → search terms over their campaign's cost per conversion → low-intent patterns (free, jobs, how-to, login) that never converted in that campaign → keywords to review. Returns ready-to-propose negatives |
| `run_gaql` | no | any read-only GAQL `SELECT` |
| `propose_changes` | no | resolves changes against the live account, dry-runs them with Google (`validateOnly`), stores a proposal with a plain-English summary |
| `apply_changes` | **yes** | applies a stored proposal (the user's own, un-applied, under 24h old); records each change's inverse |
| `undo_changes` | no | builds the reversing proposal for an applied one |
| `billing` | no | plan, free applies left, and a personal upgrade or manage-billing link |
| `discard_proposal`, `change_history`, `disconnect` | | |

Writes are limited to: add negative keywords, pause/enable a keyword or ad group, set a
campaign's daily budget (never a shared budget). No campaign creation, bid strategy changes or
deletions of anything the user built.

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
| `FREE_APPLIES` / `PRO_EMAILS` | applied proposals on the free plan (default 3; undo never counts) / emails treated as Pro |
| `STRIPE_SECRET_KEY` / `STRIPE_PRO_PRICE_ID` | Pro subscription via Stripe Checkout; unset = no upgrade links |

`scripts/try-account.ts` runs the read tools against a real account from an existing refresh
token, skipping OAuth. Use it for dogfooding.

## License

MIT
