import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { PublicChangeSchema } from "./changes.js";
import { isDemo, type UserSession } from "./session.js";

export const SERVER_NAME = "camberstack";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Camberstack connects the user's Google Ads account.
Workflow: list_accounts → account_overview → find_wasted_spend → propose_changes → show the user the summary and ask for approval → apply_changes.
Never call apply_changes unless the user has explicitly approved that specific proposal in this conversation. Every applied proposal can be reversed with undo_changes.
Free accounts get 3 applied changes; undo is always free. If apply_changes reports the limit, show the user the upgrade link it returns, word for word.
Read find_wasted_spend's "tracking" section before recommending cuts: if conversion tracking is broken or warning, say so first.
To grow an account, keyword_ideas finds what people search for around a seed or a landing page; keyword_metrics checks volume and bids for a given list. Pass the account's own market: location_ids default to the United States.
Account 000-000-0001 is a demo with sample data: anyone can try every tool on it, and changes there never touch Google. Always say when you are using it.`;

const customerId = z.string().describe("Google Ads customer ID, with or without dashes (from list_accounts)");
const locationIds = z.array(z.string().regex(/^\d+$/)).min(1).max(10).default(["2840"])
  .describe("Google geo target IDs. 2840 United States, 2826 United Kingdom, 2124 Canada, 2036 Australia, 2356 India. "
    + "For a state, city or other country, look the ID up with run_gaql: SELECT geo_target_constant.id, geo_target_constant.canonical_name "
    + "FROM geo_target_constant WHERE geo_target_constant.name = 'Denver'");
const languageId = z.string().regex(/^\d+$/).default("1000")
  .describe("Google language ID. 1000 English, 1003 Spanish, 1002 French, 1001 German, 1014 Portuguese");
const days = z.number().int().min(1).max(365).default(30).describe("Look-back window in days, ending yesterday");

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

export function buildServer(session: () => UserSession, log: (c: ToolCall) => void = () => {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const wrap = <A>(name: string, fn: (a: A) => Promise<unknown> | unknown) => {
    return async (a: A) => {
      const t0 = Date.now();
      let out: ReturnType<typeof ok> | ReturnType<typeof fail>;
      try { out = ok(await fn(a)); } catch (e) { out = fail(e); }
      const cid = (a as { customer_id?: unknown } | undefined)?.customer_id;
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
    fn: (a: A) => Promise<unknown> | unknown) =>
    server.registerTool(name, { ...config, annotations: { ...config.annotations, title: config.title } }, wrap(name, fn) as never);
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

  tool("find_wasted_spend", {
    title: "Find wasted spend",
    description: "Diagnoses where money is going with nothing to show for it: checks conversion tracking first, then search terms that spent a conversion's worth with none, low-intent patterns (free, jobs, how-to, login) that never converted, and keywords to review. Returns suggested negative keywords ready to pass to propose_changes.",
    inputSchema: { customer_id: customerId, days, campaign_id: z.string().optional().describe("Limit to one campaign") },
    annotations: read,
  }, ({ customer_id, days, campaign_id }: { customer_id: string; days: number; campaign_id?: string }) =>
    session().wastedSpend(customer_id, days, campaign_id));

  tool("run_gaql", {
    title: "Run a read-only GAQL query",
    description: "Runs any read-only Google Ads Query Language SELECT for questions the other tools don't cover. Returns up to 500 rows.",
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
      limit: z.number().int().min(1).max(200).default(50),
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

  tool("propose_changes", {
    title: "Propose changes (writes nothing)",
    description: "Checks a set of changes against the live account and dry-runs them with Google, then stores them as a proposal and returns a plain-English summary. Nothing is changed. Show the summary to the user and apply only after they approve. Supported: add_negative_keywords, pause_campaign, enable_campaign, pause_keyword, enable_keyword, pause_ad_group, enable_ad_group, set_daily_budget. Point out any ⚠ line in the summary to the user before they approve.",
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
    inputSchema: { proposal_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ proposal_id }: { proposal_id: string }) => session().undo(proposal_id));

  tool("discard_proposal", {
    title: "Discard a proposal",
    description: "Marks an open proposal as discarded so it cannot be applied.",
    inputSchema: { proposal_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ proposal_id }: { proposal_id: string }) => session().discard(proposal_id));

  tool("change_history", {
    title: "Change history",
    description: "Every proposal made through Camberstack, with what was applied, what failed, and what was undone.",
    inputSchema: { customer_id: customerId.optional(), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ customer_id, limit }: { customer_id?: string; limit: number }) => session().history(customer_id, limit));

  tool("billing", {
    title: "Plan and billing",
    description: "Shows the user's Camberstack plan: free applied changes left, or Pro. Returns a personal link to upgrade (free) or to change card and cancel (Pro). Diagnosis, proposals, history and undo are always free.",
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
