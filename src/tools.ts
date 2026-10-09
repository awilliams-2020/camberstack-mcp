import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { PublicChangeSchema } from "./changes.js";
import { isDemo, type UserSession } from "./session.js";

export const SERVER_NAME = "camberstack";
export const SERVER_VERSION = "0.9.0";

const INSTRUCTIONS = `Camberstack connects the user's Google Ads account.
Start with list_accounts. Answer the user's questions with account_overview and run_gaql (read-only). To change something: propose_changes → show the user the summary and ask for approval → apply_changes.
Never call apply_changes unless the user has explicitly approved that specific proposal in this conversation. Every applied proposal can be reversed with undo_changes.
The Free plan covers 1 Google Ads account (Pro covers 10), counted as accounts used in the last 30 days; undo and change history always work. If a tool reports the plan limit, explain it and show the upgrade link it returns, word for word.
To grow an account, keyword_ideas finds what people search for around a seed or a landing page; keyword_metrics checks volume and bids for a given list. Pass the account's own market: location_ids default to the United States.
Search Console (read-only): search_console_sites lists the user's websites; search_console_summary gives site totals against the previous period (lead with these: per-query rows leave out rare queries); search_console_performance shows their organic queries and pages; search_console_trend shows what is rising, falling, new and lost between two periods; search_console_opportunities finds near-page-1 queries and weak snippets; search_console_inspect_urls says whether Google has indexed given pages and why not; search_console_sitemaps shows when Google last read each sitemap; paid_organic_overlap joins one site with one Ads account to find searches paid for that already rank organically, and organic searches with no ads. Camberstack can't request indexing or submit sitemaps: the user does that in Search Console.
Account 000-000-0001 is a demo with sample data: anyone can try every tool on it, and changes there never touch Google. Always say when you are using it.`;

/** Tools that read or propose on one Google Ads account, so count toward the plan's accounts (session.ts checkAccount). */
const GATED = new Set(["account_overview", "run_gaql", "keyword_ideas", "keyword_metrics", "propose_changes", "paid_organic_overlap"]);

const customerId = z.string().describe("Google Ads customer ID, with or without dashes (from list_accounts)");
const locationIds = z.array(z.string().regex(/^\d+$/)).min(1).max(10).default(["2840"])
  .describe("Google geo target IDs. 2840 United States, 2826 United Kingdom, 2124 Canada, 2036 Australia, 2356 India. "
    + "For a state, city or other country, look the ID up with run_gaql: SELECT geo_target_constant.id, geo_target_constant.canonical_name "
    + "FROM geo_target_constant WHERE geo_target_constant.name = 'Denver'");
const languageId = z.string().regex(/^\d+$/).default("1000")
  .describe("Google language ID. 1000 English, 1003 Spanish, 1002 French, 1001 German, 1014 Portuguese");
const siteUrl = z.string().min(1).describe("Search Console property exactly as search_console_sites lists it, e.g. sc-domain:example.com or https://www.example.com/");
const days = z.number().int().min(1).max(365).default(30).describe("Look-back window in days, ending yesterday");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Window options shared by the Search Console tools: a day count, or exact dates; optionally Google's not-yet-final recent days. */
const scWindowShape = (defaultDays: number, maxDays: number) => ({
  days: z.number().int().min(1).max(maxDays).default(defaultDays).describe("Look-back window in days, ending 3 days ago (yesterday with fresh)"),
  start_date: ymd.optional().describe("Exact first day, YYYY-MM-DD. Pass with end_date to use exact dates instead of days"),
  end_date: ymd.optional().describe("Exact last day, YYYY-MM-DD"),
  fresh: z.boolean().default(false).describe("Include the last 2-3 days, which Google is still filling in (they read low). Use to check something from the last few days"),
});
const excludeQueryRegex = z.string().min(1).max(500).optional()
  .describe("Leave out queries matching this RE2 regex, typically the brand name, e.g. (?i)acme|ac me");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
}

export interface ToolCall {
  tool: string;
  customerId: string | null;
  ok: boolean;
  error: string | null;
  ms: number;
  bytes: number;
}

/** What the /tools page and llms.txt show about each tool; filled as buildServer registers them. */
export interface ToolDoc { name: string; title: string; description: string; inputSchema?: z.ZodRawShape; annotations: ToolAnnotations }

export function buildServer(session: () => UserSession, log: (c: ToolCall) => void = () => {}, catalog: ToolDoc[] = []): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const wrap = <A>(name: string, fn: (a: A) => Promise<unknown> | unknown) => {
    return async (a: A) => {
      const t0 = Date.now();
      const cid = (a as { customer_id?: unknown } | undefined)?.customer_id;
      let out: ReturnType<typeof ok> | ReturnType<typeof fail>;
      try {
        if (GATED.has(name) && typeof cid === "string") await session().checkAccount(cid);
        out = ok(await fn(a));
      } catch (e) { out = fail(e); }
      try {
        log({
          tool: name, customerId: typeof cid === "string" ? cid.replace(/-/g, "") : null,
          ok: !("isError" in out), error: "isError" in out ? out.content[0]!.text.slice(7, 307) : null,
          ms: Date.now() - t0, bytes: out.content[0]!.text.length,
        });
      } catch { /* logging must never break a tool */ }
      return out;
    };
  };
  // annotations.title repeats each tool's title: Claude's connector directory reads the name from there.
  // `as never`: registerTool infers its handler type from a literal inputSchema, which a helper cannot pass through.
  const tool = <A>(name: string, config: { title: string; description: string; inputSchema?: z.ZodRawShape; annotations: ToolAnnotations },
    fn: (a: A) => Promise<unknown> | unknown) => (catalog.push({ name, ...config }),
    server.registerTool(name, {
      ...config,
      inputSchema: config.inputSchema && z.object(config.inputSchema),
      annotations: { ...config.annotations, title: config.title },
    }, wrap(name, fn) as never));
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  tool("list_accounts", {
    title: "List Google Ads accounts",
    description: "Lists every Google Ads account this login can reach, including client accounts under a manager (MCC). Start here.",
    annotations: read,
  }, async () => {
    const s = session();
    const accounts = await s.accounts();
    const demo = accounts.some((a) => isDemo(a.customerId));
    return {
      accounts,
      ...(s.lastUnreadable.length ? { unreadable: s.lastUnreadable } : {}),
      ...(demo ? { note: "This Google login has no readable Google Ads account, so the demo account (sample data, a fictional business) is offered. "
        + "Tell the user plainly that it is a demo, and if `unreadable` is present, explain why their real accounts are missing." } : {}),
    };
  });

  tool("account_overview", {
    title: "Account overview",
    description: "Spend, clicks, conversions and cost per conversion per campaign over a window.",
    inputSchema: { customer_id: customerId, days },
    annotations: read,
  }, ({ customer_id, days }: { customer_id: string; days: number }) => session().overview(customer_id, days));

  tool("run_gaql", {
    title: "Run a read-only GAQL query",
    description: "Runs any read-only Google Ads Query Language SELECT for questions the other tools don't cover. Returns up to 500 rows. "
      + "Google rejects queries that break these rules: selecting or segmenting by segments.date needs a finite range in WHERE "
      + "(segments.date DURING LAST_30_DAYS, or BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'); click_view needs a single day (segments.date = 'YYYY-MM-DD'); "
      + "every field used in WHERE or ORDER BY must also be in SELECT; fields can only come from the FROM resource or resources it is "
      + "compatible with (if Google says a resource is incompatible, query that resource directly instead); "
      + "a campaign's end date is campaign.end_date_time, not campaign.end_date.",
    inputSchema: { customer_id: customerId, query: z.string().describe("A GAQL SELECT statement") },
    annotations: read,
  }, ({ customer_id, query }: { customer_id: string; query: string }) => session().runQuery(customer_id, query));

  tool("keyword_ideas", {
    title: "Keyword ideas (Keyword Planner)",
    description: "Google Keyword Planner ideas from seed keywords and/or a landing-page URL: average monthly searches, competition and the top-of-page bid range in the account's currency, biggest first. Ideas the account already targets, or already blocks as negatives, are marked in_account. Changes nothing.",
    inputSchema: {
      customer_id: customerId,
      keywords: z.array(z.string().min(1).max(80)).max(20).optional().describe("Up to 20 seed keywords"),
      url: z.string().url().optional().describe("A page to pull ideas from, such as the ad's landing page"),
      location_ids: locationIds, language_id: languageId,
      min_searches: z.number().int().min(0).default(0).describe("Drop ideas below this many average monthly searches"),
      limit: z.number().int().min(1).max(200).default(50).describe("Most ideas to return"),
    },
    annotations: read,
  }, ({ customer_id, ...o }: { customer_id: string; keywords?: string[]; url?: string; location_ids: string[]; language_id: string; min_searches: number; limit: number }) =>
    session().keywordIdeas(customer_id, o));

  tool("keyword_metrics", {
    title: "Keyword volume and bids (Keyword Planner)",
    description: "Google Keyword Planner numbers for an exact list of keywords: average monthly searches, the last 12 months, competition and the top-of-page bid range in the account's currency. Use it to size keywords before adding them or to check a trend. Changes nothing.",
    inputSchema: {
      customer_id: customerId,
      keywords: z.array(z.string().min(1).max(80)).min(1).max(100).describe("Keywords to look up"),
      location_ids: locationIds, language_id: languageId,
    },
    annotations: read,
  }, ({ customer_id, ...o }: { customer_id: string; keywords: string[]; location_ids: string[]; language_id: string }) =>
    session().keywordMetrics(customer_id, o));

  tool("search_console_sites", {
    title: "List Search Console sites",
    description: "Lists the websites (Search Console properties) this Google login can read. Use a site_url from here in the other Search Console tools.",
    annotations: read,
  }, () => session().searchConsoleSites());

  tool("search_console_summary", {
    title: "Search Console summary",
    description: "A website's total organic Google Search clicks, impressions, CTR and average position over a window, next to the same "
      + "number of days before it, with the change. Site-wide totals, more complete than adding up per-query rows. Changes nothing.",
    inputSchema: { site_url: siteUrl, ...scWindowShape(28, 240) },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean }) => session().searchConsoleSummary(site_url, o));

  tool("search_console_performance", {
    title: "Search Console performance",
    description: "Organic Google Search clicks, impressions, CTR and average position for a website, grouped by query, page, country, device or date, most clicks first. "
      + "Search Console's last 2-3 days are incomplete, so the window ends 3 days ago unless fresh is set. Group by query and page together "
      + "to see whether several pages compete for the same search; by page and date to see when a page's impressions or position changed. Changes nothing.",
    inputSchema: {
      site_url: siteUrl,
      ...scWindowShape(28, 480),
      dimensions: z.array(z.enum(["query", "page", "country", "device", "date"])).min(1).max(3).default(["query"]).describe("What to group by"),
      query_contains: z.string().min(1).max(200).optional().describe("Only queries containing this text"),
      page_contains: z.string().min(1).max(500).optional().describe("Only pages whose URL contains this text"),
      query_regex: z.string().min(1).max(500).optional().describe("Only queries matching this RE2 regex"),
      exclude_query_regex: excludeQueryRegex,
      page_regex: z.string().min(1).max(500).optional().describe("Only pages whose URL matches this RE2 regex"),
      limit: z.number().int().min(1).max(1000).default(50).describe("Most rows to return"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; dimensions: string[];
    query_contains?: string; page_contains?: string; query_regex?: string; exclude_query_regex?: string; page_regex?: string; limit: number }) =>
    session().searchConsolePerformance(site_url, o));

  tool("search_console_trend", {
    title: "Search Console trend",
    description: "Compares a window with the same number of days right before it, query by query and page by page: rising, falling, new and "
      + "lost queries, rising searches the site is losing position on, and rising and falling pages. Totals are the site's true totals. Changes nothing.",
    inputSchema: {
      site_url: siteUrl, ...scWindowShape(28, 240), exclude_query_regex: excludeQueryRegex,
      min_impressions: z.number().int().min(0).default(10).describe("Skip queries and pages under this many impressions in both windows"),
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; exclude_query_regex?: string; min_impressions: number; limit: number }) =>
    session().searchConsoleTrend(site_url, o));

  tool("search_console_opportunities", {
    title: "Search Console opportunities",
    description: "Finds where more organic clicks are within reach: queries on positions 4-20 with the clicks a realistic climb would add, top-5 "
      + "queries with an unusually low click-through rate (a title or description to fix), and question-shaped queries. Changes nothing.",
    inputSchema: {
      site_url: siteUrl, ...scWindowShape(90, 480), exclude_query_regex: excludeQueryRegex,
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ site_url, ...o }: { site_url: string; days: number; start_date?: string; end_date?: string; fresh: boolean; exclude_query_regex?: string; limit: number }) =>
    session().searchConsoleOpportunities(site_url, o));

  tool("search_console_inspect_urls", {
    title: "Inspect URLs in Google's index",
    description: "Google's index record for each page: indexed or not and the reason (for example \"Discovered - currently not indexed\"), "
      + "last crawl, robots.txt and fetch result, the canonical Google chose against the one the page declares, and structured-data items "
      + "with their errors. Use it when a page gets no impressions, or seems to have dropped, before assuming a ranking problem. Changes nothing.",
    inputSchema: {
      site_url: siteUrl,
      urls: z.array(z.string().url().max(2000)).min(1).max(20).describe("Full page URLs inside the property, up to 20 per call (Google allows 2,000 a day per site)"),
    },
    annotations: read,
  }, ({ site_url, urls }: { site_url: string; urls: string[] }) => session().searchConsoleInspectUrls(site_url, urls));

  tool("search_console_sitemaps", {
    title: "Search Console sitemaps",
    description: "The sitemaps submitted for a website: when Google last downloaded each one, how many URLs it lists, and its error and "
      + "warning counts. Read-only: submitting a sitemap is done in Search Console. Changes nothing.",
    inputSchema: { site_url: siteUrl },
    annotations: read,
  }, ({ site_url }: { site_url: string }) => session().searchConsoleSitemaps(site_url));

  tool("paid_organic_overlap", {
    title: "Paid vs organic overlap",
    description: "Joins a Google Ads account's search terms with a website's Search Console queries over the same days. Returns paid_and_ranking "
      + "(searches you pay for where the site already ranks near the top organically, with ad spend) and organic_gaps (searches the site "
      + "shows up for on page 2 or lower with no ad or keyword). Changes nothing; follow up with propose_changes.",
    inputSchema: {
      customer_id: customerId, site_url: siteUrl,
      days: z.number().int().min(7).max(480).default(90).describe("Look-back window in days, ending 3 days ago"),
      max_position: z.number().min(1).max(10).default(3).describe("paid_and_ranking: average organic position at or better than this"),
      min_impressions: z.number().int().min(0).default(100).describe("organic_gaps: only queries with at least this many impressions"),
      limit: z.number().int().min(1).max(200).default(25).describe("Most rows in each list"),
    },
    annotations: read,
  }, ({ customer_id, site_url, ...o }: { customer_id: string; site_url: string; days: number; max_position: number; min_impressions: number; limit: number }) =>
    session().paidOrganicOverlap(customer_id, site_url, o));

  tool("propose_changes", {
    title: "Propose changes (writes nothing)",
    description: "Checks a set of changes against the live account and dry-runs them with Google, then stores them as a proposal and returns a plain-English summary. Nothing is changed. Show the summary to the user and apply only after they approve. Supported: add_negative_keywords, pause_campaign, enable_campaign, pause_keyword, enable_keyword, pause_ad_group, enable_ad_group, set_daily_budget, set_end_date, and building: create_campaign (a whole Search campaign with ad groups, keywords, ads, targeting, negatives and sitelinks; always created paused, so turning it on is a separate enable_campaign), add_ad_group, add_keywords, add_responsive_search_ad, add_sitelinks, set_conversion_goal; and tuning: set_keyword_bid, set_ad_group_bid, pause_ad, enable_ad (to replace an ad: add the new one and pause the old in one proposal), add_campaign_targeting, remove_campaign_targeting, set_location_mode, set_bidding_strategy, set_url_suffix, create_conversion_action, set_conversion_counting. Point out any ⚠ line in the summary to the user before they approve.",
    inputSchema: { customer_id: customerId, changes: z.array(PublicChangeSchema).min(1).describe("Changes to propose; several can go in one proposal") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ customer_id, changes }: { customer_id: string; changes: unknown[] }) => session().propose(customer_id, changes));

  tool("apply_changes", {
    title: "Apply an approved proposal",
    description: "Applies a proposal from propose_changes to the Google Ads account. Only call this after the user has explicitly approved that proposal. Each change is logged and can be reversed with undo_changes.",
    inputSchema: { proposal_id: z.string().describe("The id returned by propose_changes") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ proposal_id }: { proposal_id: string }) => session().apply(proposal_id));

  tool("undo_changes", {
    title: "Undo an applied proposal",
    description: "Builds a new proposal that reverses an applied one (removes the negatives it added, restores statuses and budgets). Like any proposal, it must be approved and applied.",
    inputSchema: { proposal_id: z.string().describe("The id of an applied proposal, from change_history or apply_changes") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ proposal_id }: { proposal_id: string }) => session().undo(proposal_id));

  tool("discard_proposal", {
    title: "Discard a proposal",
    description: "Marks an open proposal as discarded so it cannot be applied.",
    inputSchema: { proposal_id: z.string().describe("The id returned by propose_changes") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ proposal_id }: { proposal_id: string }) => session().discard(proposal_id));

  tool("change_history", {
    title: "Change history",
    description: "Every proposal made through Camberstack, with what was applied, what failed, and what was undone.",
    inputSchema: { customer_id: customerId.optional(), limit: z.number().int().min(1).max(100).default(20).describe("Most proposals to return, newest first") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ customer_id, limit }: { customer_id?: string; limit: number }) => session().history(customer_id, limit));

  tool("billing", {
    title: "Plan and billing",
    description: "Shows the user's Camberstack plan: the Google Ads accounts used in the last 30 days against the number the plan covers (Free 1, Pro 10). Returns a personal link to upgrade (Free) or to change card and cancel (Pro).",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => session().plan());

  tool("disconnect", {
    title: "Disconnect Google Ads",
    description: "Revokes Camberstack's Google access and deletes the stored credentials. The user must confirm.",
    inputSchema: { confirm: z.literal(true).describe("Must be true; ask the user first") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, () => session().disconnect());

  return server;
}

/** Every tool in registration (workflow) order, without a session: nothing is ever called. */
export function toolCatalog(): ToolDoc[] {
  const catalog: ToolDoc[] = [];
  buildServer(() => { throw new Error("catalog only"); }, undefined, catalog);
  return catalog;
}
