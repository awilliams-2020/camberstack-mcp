import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ChangeSchema } from "./changes.js";
import type { UserSession } from "./session.js";

export const SERVER_NAME = "camberstack";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Camberstack connects the user's Google Ads account.
Workflow: list_accounts → account_overview → find_wasted_spend → propose_changes → show the user the summary and ask for approval → apply_changes.
Never call apply_changes unless the user has explicitly approved that specific proposal in this conversation. Every applied proposal can be reversed with undo_changes.
Free accounts get 3 applied changes; undo is always free. If apply_changes reports the limit, show the user the upgrade link it returns, word for word.
Read find_wasted_spend's "tracking" section before recommending cuts: if conversion tracking is broken or warning, say so first.`;

const customerId = z.string().describe("Google Ads customer ID, with or without dashes (from list_accounts)");
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
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool("list_accounts", {
    title: "List Google Ads accounts",
    description: "Lists every Google Ads account this login can reach, including client accounts under a manager (MCC). Start here.",
    annotations: { ...read, title: "List Google Ads accounts" },
  }, wrap("list_accounts", async () => {
    const s = session();
    const accounts = await s.accounts();
    return s.lastUnreadable.length ? { accounts, unreadable: s.lastUnreadable } : { accounts };
  }));

  server.registerTool("account_overview", {
    title: "Account overview",
    description: "Spend, clicks, conversions and cost per conversion per campaign over a window.",
    inputSchema: { customer_id: customerId, days },
    annotations: { ...read, title: "Account overview" },
  }, wrap("account_overview", ({ customer_id, days }: { customer_id: string; days: number }) => session().overview(customer_id, days)));

  server.registerTool("find_wasted_spend", {
    title: "Find wasted spend",
    description: "Diagnoses where money is going with nothing to show for it: checks conversion tracking first, then search terms that spent a conversion's worth with none, low-intent patterns (free, jobs, how-to, login) that never converted, and keywords to review. Returns suggested negative keywords ready to pass to propose_changes.",
    inputSchema: { customer_id: customerId, days, campaign_id: z.string().optional().describe("Limit to one campaign") },
    annotations: { ...read, title: "Find wasted spend" },
  }, wrap("find_wasted_spend", ({ customer_id, days, campaign_id }: { customer_id: string; days: number; campaign_id?: string }) =>
    session().wastedSpend(customer_id, days, campaign_id)));

  server.registerTool("run_gaql", {
    title: "Run a read-only GAQL query",
    description: "Runs any read-only Google Ads Query Language SELECT for questions the other tools don't cover. Returns up to 500 rows.",
    inputSchema: { customer_id: customerId, query: z.string().describe("A GAQL SELECT statement") },
    annotations: { ...read, title: "Run a read-only GAQL query" },
  }, wrap("run_gaql", ({ customer_id, query }: { customer_id: string; query: string }) => session().runQuery(customer_id, query)));

  server.registerTool("propose_changes", {
    title: "Propose changes (writes nothing)",
    description: "Checks a set of changes against the live account and dry-runs them with Google, then stores them as a proposal and returns a plain-English summary. Nothing is changed. Show the summary to the user and apply only after they approve. Supported: add_negative_keywords, pause_keyword, enable_keyword, pause_ad_group, enable_ad_group, set_daily_budget.",
    inputSchema: { customer_id: customerId, changes: z.array(ChangeSchema).min(1).describe("Changes to propose") },
    annotations: { title: "Propose changes (writes nothing)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap("propose_changes", ({ customer_id, changes }: { customer_id: string; changes: unknown[] }) => session().propose(customer_id, changes)));

  server.registerTool("apply_changes", {
    title: "Apply an approved proposal",
    description: "Applies a proposal from propose_changes to the Google Ads account. Only call this after the user has explicitly approved that proposal. Each change is logged and can be reversed with undo_changes.",
    inputSchema: { proposal_id: z.string().describe("The id returned by propose_changes") },
    annotations: { title: "Apply an approved proposal", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, wrap("apply_changes", ({ proposal_id }: { proposal_id: string }) => session().apply(proposal_id)));

  server.registerTool("undo_changes", {
    title: "Undo an applied proposal",
    description: "Builds a new proposal that reverses an applied one (removes the negatives it added, restores statuses and budgets). Like any proposal, it must be approved and applied.",
    inputSchema: { proposal_id: z.string() },
    annotations: { title: "Undo an applied proposal", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap("undo_changes", ({ proposal_id }: { proposal_id: string }) => session().undo(proposal_id)));

  server.registerTool("discard_proposal", {
    title: "Discard a proposal",
    description: "Marks an open proposal as discarded so it cannot be applied.",
    inputSchema: { proposal_id: z.string() },
    annotations: { title: "Discard a proposal", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, wrap("discard_proposal", ({ proposal_id }: { proposal_id: string }) => session().discard(proposal_id)));

  server.registerTool("change_history", {
    title: "Change history",
    description: "Every proposal made through Camberstack, with what was applied, what failed, and what was undone.",
    inputSchema: { customer_id: customerId.optional(), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { title: "Change history", readOnlyHint: true, openWorldHint: false },
  }, wrap("change_history", ({ customer_id, limit }: { customer_id?: string; limit: number }) => session().history(customer_id, limit)));

  server.registerTool("billing", {
    title: "Plan and billing",
    description: "Shows the user's Camberstack plan: free applied changes left, or Pro. Returns a personal link to upgrade (free) or to change card and cancel (Pro). Diagnosis, proposals, history and undo are always free.",
    annotations: { title: "Plan and billing", readOnlyHint: true, openWorldHint: false },
  }, wrap("billing", () => session().plan()));

  server.registerTool("disconnect", {
    title: "Disconnect Google Ads",
    description: "Revokes Camberstack's Google access and deletes the stored credentials. The user must confirm.",
    inputSchema: { confirm: z.literal(true).describe("Must be true; ask the user first") },
    annotations: { title: "Disconnect Google Ads", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, wrap("disconnect", () => session().disconnect()));

  return server;
}
