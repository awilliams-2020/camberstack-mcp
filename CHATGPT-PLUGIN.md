# ChatGPT plugin submission

Text to paste into ChatGPT's plugin creator, which builds and zips the package itself. Server details:
MCP URL `https://camberstack.io/mcp`, Streamable HTTP, **OAuth with dynamic client registration** (no client ID
or secret to enter). Version: keep in step with `package.json`.

## Listing

| field | value |
|---|---|
| Display name (≤30) | Camberstack: Google Ads |
| Short description (≤30) | Google Ads changes you approve |
| Developer name | Camberstack |
| Category | Business & Operations |
| Website | https://camberstack.io |
| Support | https://camberstack.io/docs |
| Privacy policy | https://camberstack.io/privacy |
| Terms | https://camberstack.io/terms |
| Brand color (light / dark) | #1F5F4A / #6FC4A4 |
| Logo | `brand/logo-512.png` (square, 512px) |

Starter prompts (≤3, ≤128 chars, no @-mentions):
- Show me Camberstack's demo account and how each campaign did last month
- Which search terms cost me money without converting in the last 30 days?
- Find negative keywords for my worst campaign and show me the change first

Long description (≤4000):

> Camberstack connects your Google Ads account to ChatGPT with a Google sign-in: no developer token, API keys or Google Cloud project. Camberstack accesses the Google Ads API under its own developer-token access, with your Google OAuth consent.
>
> Ask anything about your account, from spend and conversions to the search terms you pay for, and research new keywords with Keyword Planner. When you want a change, ChatGPT proposes it first: negative keywords, budgets, pauses, bids and bid strategy, targeting, conversion goals, or a whole new Search, Performance Max, Display or YouTube campaign (always created paused). Each proposal is checked with Google before you see it. Nothing changes until you approve, and every applied change is logged and can be undone.
>
> Optional read-only Search Console shows your organic queries and the searches you pay for that already rank. Works with manager (MCC) accounts.
>
> Free on one Google Ads account, with every tool. A demo account with sample data lets you try everything first: ask for Camberstack's demo account.

## Domain verification

The portal shows a token for `https://camberstack.io/.well-known/openai-apps-challenge`. Put it in
`projects/camberstack/.env` as `OPENAI_APPS_CHALLENGE=<token>`, redeploy with `projects/camberstack/deploy.sh`
(the env is read at boot), check `curl https://camberstack.io/.well-known/openai-apps-challenge` returns the bare
token, then press **Verify Domain**.

## Reviewer credentials

The only sign-in is Google's, and review requires one that works with no MFA, SMS or email codes. Use a
**dedicated Gmail account with 2-Step Verification off and no Google Ads access**: Camberstack then offers
only the demo account (sample data, a fictional plumbing business), and changes there never reach Google.
Never give reviewers a login that can see a real Ads account.

Sign-in instructions to paste:

> Connect the plugin and sign in with the Google account below. On Google's consent screen, leave the boxes
> ticked. This account has no Google Ads access of its own, so Camberstack offers its demo account
> 000-000-0001 (sample data for a fictional plumbing business). Every tool works on it, and changes there
> never reach Google. Ask: "Show me Camberstack's demo account." Search Console tools need a verified site,
> which this account doesn't have, so they answer that no sites are listed.

Before submitting, sign in once with that account from a new browser profile and run every test case below.
Google can still ask "Verify it's you" on a reviewer's first sign-in from a new location; that is the
likeliest reason for a rejection here.

## Test cases

### Positive (exactly 5)

1. **Description:** Reads campaign performance from the demo account.
   **Prompt:** Show me Camberstack's demo account and how each campaign did in the last 30 days.
   **Tools triggered:** `list_accounts`, `account_overview`
   **Expected behavior:** Says it is using the demo account (sample data), then lists its campaigns (five
   enabled, one paused) with spend, conversions and cost per conversion.

2. **Description:** Finds search terms that cost money without converting.
   **Prompt:** In the demo account, which search terms cost money without converting in the last 30 days?
   **Tools triggered:** `run_gaql`
   **Expected behavior:** Lists search terms with clicks and cost and zero conversions, such as
   "how to unclog a drain". Nothing is changed.

3. **Description:** Proposes a change without applying it.
   **Prompt:** In the demo account, add "how to" as a negative keyword to the Drain Cleaning – Search campaign. Show me the change first.
   **Tools triggered:** `propose_changes`
   **Expected behavior:** Shows a proposal (id starting `p_`) adding the negative keyword "how to" to Drain
   Cleaning – Search, and asks for approval. The account is not changed.

4. **Description:** Applies an approved proposal, then undoes it.
   **Prompt:** Apply that proposal. Then undo it.
   **Tools triggered:** `apply_changes`, `undo_changes`
   **Expected behavior:** Applies the proposal from case 3 and confirms it. For the undo, proposes the reverse
   (removing the negative keyword), asks for approval, and applies it when approved. `change_history` lists both.

5. **Description:** Researches new keywords with Keyword Planner.
   **Prompt:** Using the demo account, find keyword ideas for an emergency plumber, with monthly searches and top-of-page bids.
   **Tools triggered:** `keyword_ideas`
   **Expected behavior:** Lists plumbing keyword ideas with average monthly searches, competition and bid range.
   Nothing is changed.

### Negative (exactly 3)

1. **Description:** Unrelated request.
   **Prompt:** Write a short poem about the ocean.
   **Why it shouldn't act / expected:** Nothing to do with Google Ads or Search Console. No Camberstack tool is
   called; ChatGPT answers on its own.

2. **Description:** Another ad platform.
   **Prompt:** Raise my Facebook ads budget to $50 a day.
   **Why it shouldn't act / expected:** Camberstack covers Google Ads only. No tool is called; ChatGPT says
   Camberstack can't change Facebook or Meta ads.

3. **Description:** Deletion request.
   **Prompt:** Delete all the campaigns in the demo account.
   **Why it shouldn't act / expected:** Camberstack has no delete operation. No change is proposed or applied;
   ChatGPT explains it can pause campaigns (as a proposal you approve) but can't delete them.

## Tool annotation justifications

Every tool sets `readOnlyHint`, `destructiveHint` and `openWorldHint`. Reasons, per tool:

| tool | readOnly | destructive | openWorld | justification |
|---|---|---|---|---|
| `list_accounts` | true | false | true | Lists the Google Ads accounts the user's Google login can read, from the Google Ads API. Changes nothing. Open world: calls Google's API. |
| `account_overview` | true | false | true | Reads an account's campaigns and spend from the Google Ads API. Changes nothing. Open world: calls Google's API. |
| `run_gaql` | true | false | true | Runs a read-only Google Ads Query Language query (SELECT only; the API has no write form of GAQL). Open world: calls Google's API. |
| `keyword_ideas` | true | false | true | Reads keyword ideas from Google's Keyword Planner. Changes nothing in the account. Open world: calls Google's API. |
| `keyword_metrics` | true | false | true | Reads search volume and bids for given keywords from Keyword Planner. Changes nothing. Open world: calls Google's API. |
| `search_console_sites` | true | false | true | Lists the user's Search Console properties, with a read-only scope. Open world: calls Google's API. |
| `search_console_summary` | true | false | true | Reads site-wide search totals from Search Console, read-only scope. Open world: calls Google's API. |
| `search_console_performance` | true | false | true | Reads queries and pages from Search Console, read-only scope. Open world: calls Google's API. |
| `search_console_trend` | true | false | true | Compares two periods of Search Console data, read-only scope. Open world: calls Google's API. |
| `search_console_opportunities` | true | false | true | Reads Search Console data and ranks near-page-1 queries, read-only scope. Open world: calls Google's API. |
| `search_console_inspect_urls` | true | false | true | Reads Google's index status for given URLs (URL Inspection API, read-only). Cannot request indexing. Open world: calls Google's API. |
| `search_console_sitemaps` | true | false | true | Reads sitemap status from Search Console. Cannot submit sitemaps. Open world: calls Google's API. |
| `paid_organic_overlap` | true | false | true | Reads Google Ads search terms and Search Console queries and joins them. Changes nothing. Open world: calls both Google APIs. |
| `propose_changes` | false | false | true | Stores a proposed change in Camberstack (a write to our own store, so not read-only) and validates it with Google using validate-only mode, which never changes the account. Not destructive: nothing in Google Ads changes. Open world: calls Google's API. |
| `apply_changes` | false | true | true | Applies a proposal the user approved to their live Google Ads account (for example a budget, bid or pause). It overwrites existing settings, so it is marked destructive, though each change can be reversed with `undo_changes`. It refuses anything not proposed first, older than 24 hours, or owned by someone else. Open world: writes through Google's API. |
| `undo_changes` | false | false | true | Builds the reverse of an applied proposal as a new proposal (stored in Camberstack, validated with Google, nothing applied). Not destructive: the user must approve and apply it. Open world: calls Google's API. |
| `discard_proposal` | false | false | false | Marks a not-yet-applied proposal as discarded in Camberstack's own store. Touches nothing in Google Ads and loses nothing the user built. Closed world: no external call. |
| `change_history` | true | false | false | Reads the user's applied-change log from Camberstack's own store. Closed world: no external call. |
| `billing` | true | false | false | Reads the user's plan and usage from Camberstack and returns a checkout or billing-portal link. Changes nothing itself. Closed world: no external call. |
| `disconnect` | false | true | true | Deletes the user's stored Google token and revokes it with Google, ending Camberstack's access. Destructive: the connection must be made again. Open world: calls Google's revoke endpoint. |

## Release notes

> First submission to the ChatGPT plugin directory. Camberstack 0.10.1: a hosted Google Ads MCP server with
> Google sign-in (OAuth with dynamic client registration). 20 tools: read Google Ads (account overview, GAQL
> queries), Keyword Planner research, read-only Search Console, and approval-gated changes (propose, apply,
> undo) covering negatives, budgets, pauses, bids, targeting, conversion goals and paused new Search,
> Performance Max, Display and YouTube campaigns. Includes a demo account with sample data.

## Demo recording

Required. Record a run through positive cases 1, 3 and 4 in ChatGPT with the reviewer account: connect, the
demo overview, a proposal shown before anything changes, apply, then undo. Upload it unlisted (YouTube or
Loom) and paste the link.

## Commerce

`commerce: true`. Paste: "Free on one Google Ads account. Pro ($15/month, up to 10 accounts) is purchased on
camberstack.io through Stripe checkout; the plugin only returns a link to that page and takes no payment in
ChatGPT."
