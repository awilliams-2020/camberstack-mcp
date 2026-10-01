/**
 * The demo account: a fictional advertiser ("Northwind Plumbing") that behaves like a Google Ads account
 * behind the same search/mutate interface, so every tool works on it unchanged. It exists so people can
 * try the whole flow (diagnose → propose → apply → undo) before trusting a tool with their real account,
 * and so directory reviewers never need a shared Google login with Ads access.
 *
 * Shown in list_accounts only when a login has no readable real account; reachable by its id always.
 * Writes change a per-user copy kept in SQLite (demo_state), never Google, and never use free applies.
 *
 * search() understands the GAQL the tools send and simple hand-written queries (run_gaql): FROM one of
 * the resources below, WHERE conditions joined by AND (=, !=, <, >, <=, >=, IN, LIKE), ORDER BY, LIMIT.
 * Rows come back whole (camelCase, like the API); metrics scale with the segments.date window.
 */
import type { DB } from "./db.js";
import { now } from "./db.js";

export const DEMO_CID = "0000000001";
export const DEMO_NAME = "DEMO: Northwind Plumbing (sample data)";
export const DEMO_NOTE = "Sample data from Camberstack's demo account (a fictional plumbing business), not a real Google Ads account. Changes apply to the demo only.";

const HISTORY_DAYS = 180;

// ---------------------------------------------------------------- the account, 180 days of history

type Campaign = { id: string; name: string; type: string; bidding: string; budget: number; status: string; hidden?: { cost: number; clicks: number; conv: number } };
const CAMPAIGNS: Campaign[] = [
  { id: "2001", name: "Emergency Plumbing – Search", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 40, status: "ENABLED" },
  { id: "2002", name: "Water Heaters – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 25, status: "ENABLED" },
  { id: "2003", name: "Drain Cleaning – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 20, status: "ENABLED" },
  { id: "2004", name: "Brand – Northwind", type: "SEARCH", bidding: "TARGET_IMPRESSION_SHARE", budget: 10, status: "ENABLED" },
  { id: "2005", name: "Performance Max – Services", type: "PERFORMANCE_MAX", bidding: "MAXIMIZE_CONVERSIONS", budget: 30, status: "ENABLED",
    hidden: { cost: 1624.35, clicks: 1208, conv: 9 } },
  { id: "2006", name: "Bathroom Remodels – Search", type: "SEARCH", bidding: "MANUAL_CPC", budget: 15, status: "PAUSED" },
];
const AD_GROUPS: { id: string; campaign: string; name: string; status: string }[] = [
  { id: "3001", campaign: "2001", name: "Emergency Plumber", status: "ENABLED" },
  { id: "3002", campaign: "2001", name: "Burst Pipes & Leaks", status: "ENABLED" },
  { id: "3003", campaign: "2002", name: "Water Heater Install", status: "ENABLED" },
  { id: "3004", campaign: "2002", name: "Water Heater Repair", status: "ENABLED" },
  { id: "3005", campaign: "2003", name: "Drain Cleaning", status: "ENABLED" },
  { id: "3006", campaign: "2003", name: "Sewer Line", status: "PAUSED" },
  { id: "3007", campaign: "2004", name: "Brand", status: "ENABLED" },
  { id: "3008", campaign: "2006", name: "Bathroom Remodel", status: "ENABLED" },
];
const KEYWORDS: { id: string; adGroup: string; text: string; match: string; status: string }[] = [
  { id: "4001", adGroup: "3001", text: "emergency plumber", match: "PHRASE", status: "ENABLED" },
  { id: "4002", adGroup: "3001", text: "24 hour plumber", match: "PHRASE", status: "ENABLED" },
  { id: "4003", adGroup: "3001", text: "plumber near me", match: "BROAD", status: "ENABLED" },
  { id: "4004", adGroup: "3002", text: "burst pipe repair", match: "PHRASE", status: "ENABLED" },
  { id: "4005", adGroup: "3002", text: "water leak repair", match: "BROAD", status: "ENABLED" },
  { id: "4006", adGroup: "3003", text: "water heater installation", match: "PHRASE", status: "ENABLED" },
  { id: "4007", adGroup: "3003", text: "tankless water heater", match: "BROAD", status: "ENABLED" },
  { id: "4008", adGroup: "3004", text: "water heater repair", match: "PHRASE", status: "ENABLED" },
  { id: "4009", adGroup: "3005", text: "drain cleaning", match: "BROAD", status: "ENABLED" },
  { id: "4010", adGroup: "3005", text: "clogged drain", match: "BROAD", status: "ENABLED" },
  { id: "4011", adGroup: "3006", text: "sewer line repair", match: "PHRASE", status: "ENABLED" },
  { id: "4012", adGroup: "3007", text: "northwind plumbing", match: "EXACT", status: "ENABLED" },
  { id: "4013", adGroup: "3008", text: "bathroom remodel", match: "PHRASE", status: "ENABLED" },
];
// [keyword id, search term, cost, clicks, conversions] over 180 days
const TERMS: [string, string, number, number, number][] = [
  ["4001", "emergency plumber near me", 412.5, 96, 14], ["4001", "emergency plumber", 288.1, 70, 9],
  ["4002", "24 hour plumber near me", 196.4, 44, 6], ["4003", "plumber near me", 355.2, 118, 7],
  ["4003", "plumber jobs near me", 84.6, 31, 0], ["4003", "plumber salary", 41.2, 16, 0],
  ["4003", "how to become a plumber", 37.9, 12, 0], ["4003", "plumbing apprenticeship near me", 52.3, 15, 0],
  ["4004", "burst pipe repair", 164.8, 29, 4], ["4005", "water leak repair near me", 121.4, 33, 3],
  ["4005", "how to fix a leaking pipe", 63.7, 27, 0], ["4005", "free leak detection", 38.2, 11, 0],
  ["4006", "water heater installation", 302.6, 58, 5], ["4007", "tankless water heater", 241.3, 87, 1],
  ["4007", "tankless water heater reviews", 118.9, 44, 0], ["4007", "best tankless water heater", 97.4, 39, 0],
  ["4007", "how to install a tankless water heater", 72.1, 25, 0], ["4008", "water heater repair", 188.7, 41, 4],
  ["4008", "water heater repair free estimate", 46.3, 12, 1],
  ["4009", "drain cleaning", 214.4, 61, 0], ["4009", "drain cleaning near me", 176.2, 49, 0],
  ["4010", "how to unclog a drain", 118.6, 52, 0], ["4010", "diy drain cleaner", 66.3, 28, 0],
  ["4010", "free drain cleaning", 44.9, 14, 0], ["4010", "clogged drain", 129.8, 40, 0],
  ["4011", "sewer line repair", 98.2, 15, 0],
  ["4012", "northwind plumbing", 62.4, 88, 11], ["4012", "northwind plumbing reviews", 18.3, 21, 2],
  ["4013", "bathroom remodel near me", 140.2, 30, 1], ["4013", "bathroom remodel ideas", 88.5, 41, 0],
];
const CONVERSION_ACTIONS = [
  { id: "5001", name: "Calls from ads", category: "PHONE_CALL_LEAD", status: "ENABLED", primaryForGoal: true, type: "AD_CALL" },
  { id: "5002", name: "Online booking", category: "SUBMIT_LEAD_FORM", status: "ENABLED", primaryForGoal: true, type: "WEBPAGE" },
  { id: "5003", name: "Thank-you page view", category: "PAGE_VIEW", status: "ENABLED", primaryForGoal: false, type: "WEBPAGE" },
];
/** Searches Google hides below its privacy threshold: campaign totals run this much above their terms. */
const HIDDEN_SHARE = 1.12;

// ---------------------------------------------------------------- per-user mutable state

interface State {
  campaignStatus: Record<string, string>;
  budget: Record<string, number>;
  adGroupStatus: Record<string, string>;
  keywordStatus: Record<string, string>;
  negatives: { resourceName: string; campaign: string; text: string; match: string }[];
  nextId: number;
}

function fresh(): State {
  return {
    campaignStatus: Object.fromEntries(CAMPAIGNS.map((c) => [c.id, c.status])),
    budget: Object.fromEntries(CAMPAIGNS.map((c) => [c.id, c.budget])),
    adGroupStatus: Object.fromEntries(AD_GROUPS.map((g) => [g.id, g.status])),
    keywordStatus: Object.fromEntries(KEYWORDS.map((k) => [k.id, k.status])),
    negatives: [{ resourceName: `customers/${DEMO_CID}/campaignCriteria/2001~9001`, campaign: "2001", text: "diy", match: "PHRASE" }],
    nextId: 9100,
  };
}

export class DemoAds {
  constructor(private db: DB, private userId: string) {}

  private load(): State {
    const row = this.db.prepare("SELECT state FROM demo_state WHERE user_id = ?").get(this.userId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as State : fresh();
  }
  private save(s: State): void {
    this.db.prepare(`INSERT INTO demo_state (user_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(this.userId, JSON.stringify(s), now());
  }

  /** Every row of a resource, built from the base data plus this user's changes, scaled to `days`. */
  private rows(resource: string, s: State, days: number): any[] {
    const f = Math.min(days, HISTORY_DAYS) / HISTORY_DAYS;
    const m = (cost: number, clicks: number, conv: number, share = 1) => ({
      costMicros: String(Math.round(cost * share * f * 1e6)), clicks: String(Math.round(clicks * share * f)),
      impressions: String(Math.round(clicks * share * f * 14)), conversions: Math.round(conv * f * 10) / 10, conversionsValue: 0,
    });
    const camp = (id: string) => {
      const c = CAMPAIGNS.find((x) => x.id === id)!;
      return { id: c.id, name: c.name, status: s.campaignStatus[c.id], advertisingChannelType: c.type, biddingStrategyType: c.bidding,
        resourceName: `customers/${DEMO_CID}/campaigns/${c.id}` };
    };
    const group = (id: string) => {
      const g = AD_GROUPS.find((x) => x.id === id)!;
      return { id: g.id, name: g.name, status: s.adGroupStatus[g.id], resourceName: `customers/${DEMO_CID}/adGroups/${g.id}` };
    };
    const kwOf = (k: typeof KEYWORDS[number]) => ({
      criterionId: k.id, status: s.keywordStatus[k.id], type: "KEYWORD", keyword: { text: k.text, matchType: k.match },
      resourceName: `customers/${DEMO_CID}/adGroupCriteria/${k.adGroup}~${k.id}`,
    });
    const termsOfKw = (kid: string) => TERMS.filter((t) => t[0] === kid);
    const sum = (ts: typeof TERMS) => ts.reduce((a, t) => [a[0] + t[2], a[1] + t[3], a[2] + t[4]], [0, 0, 0]);
    const groupOfKw = (kid: string) => KEYWORDS.find((k) => k.id === kid)!.adGroup;
    const campOfGroup = (gid: string) => AD_GROUPS.find((g) => g.id === gid)!.campaign;

    switch (resource) {
      case "customer":
        return [{ customer: { id: DEMO_CID, descriptiveName: DEMO_NAME, currencyCode: "USD", timeZone: "America/Chicago", manager: false } }];
      case "customer_client":
        return [{ customerClient: { id: DEMO_CID, descriptiveName: DEMO_NAME, currencyCode: "USD", manager: false, level: 0, status: "ENABLED" } }];
      case "campaign":
        return CAMPAIGNS.map((c) => {
          const ts = TERMS.filter((t) => campOfGroup(groupOfKw(t[0])) === c.id);
          const [cost, clicks, conv] = c.hidden ? [c.hidden.cost, c.hidden.clicks, c.hidden.conv] : sum(ts);
          return { campaign: camp(c.id),
            campaignBudget: { resourceName: `customers/${DEMO_CID}/campaignBudgets/${c.id}`, amountMicros: String(Math.round(s.budget[c.id]! * 1e6)), explicitlyShared: false },
            metrics: m(cost, clicks, conv, c.hidden ? 1 : HIDDEN_SHARE) };
        });
      case "ad_group":
        return AD_GROUPS.map((g) => {
          const [cost, clicks, conv] = sum(TERMS.filter((t) => groupOfKw(t[0]) === g.id));
          return { campaign: camp(g.campaign), adGroup: group(g.id), metrics: m(cost, clicks, conv, HIDDEN_SHARE) };
        });
      case "keyword_view":
      case "ad_group_criterion":
        return KEYWORDS.map((k) => {
          const [cost, clicks, conv] = sum(termsOfKw(k.id));
          return { campaign: camp(campOfGroup(k.adGroup)), adGroup: group(k.adGroup), adGroupCriterion: kwOf(k), metrics: m(cost, clicks, conv) };
        });
      case "search_term_view":
        return TERMS.map(([kid, term, cost, clicks, conv]) => ({
          campaign: camp(campOfGroup(groupOfKw(kid))), adGroup: group(groupOfKw(kid)),
          searchTermView: { searchTerm: term, status: "NONE" }, metrics: m(cost, clicks, conv),
        }));
      case "conversion_action":
        return CONVERSION_ACTIONS.map((a) => ({ conversionAction: { ...a, resourceName: `customers/${DEMO_CID}/conversionActions/${a.id}` } }));
      case "campaign_criterion":
        return s.negatives.map((n) => ({
          campaign: camp(n.campaign),
          campaignCriterion: { resourceName: n.resourceName, criterionId: n.resourceName.split("~")[1], type: "KEYWORD", negative: true,
            keyword: { text: n.text, matchType: n.match } },
        }));
      default:
        throw new Error(`The demo account supports these GAQL resources: customer, campaign, ad_group, keyword_view, ad_group_criterion, `
          + `search_term_view, campaign_criterion, conversion_action. "${resource}" isn't one of them.`);
    }
  }

  async listAccessibleCustomers(): Promise<string[]> { return [DEMO_CID]; }

  async search(_cid: string, query: string): Promise<any[]> {
    const q = parse(query);
    const s = this.load();
    let rows = this.rows(q.from, s, q.days).filter((r) => q.where.every((w) => w(r)));
    if (q.orderBy) {
      const { path, desc } = q.orderBy;
      rows = rows.sort((a, b) => cmp(get(a, path), get(b, path)) * (desc ? -1 : 1));
    }
    return q.limit ? rows.slice(0, q.limit) : rows;
  }

  async mutate(_cid: string, service: string, operations: any[], opts: { validateOnly?: boolean } = {}): Promise<{ results: { resourceName?: string }[] }> {
    const s = this.load();
    const id = (rn: string) => rn.split("/").pop()!;
    const results = operations.map((op) => {
      if (service === "campaignCriteria" && op.create) {
        const camp = id(op.create.campaign);
        if (!CAMPAIGNS.some((c) => c.id === camp)) throw new Error(`Campaign ${camp} not found in the demo account`);
        const resourceName = `customers/${DEMO_CID}/campaignCriteria/${camp}~${s.nextId++}`;
        s.negatives.push({ resourceName, campaign: camp, text: op.create.keyword.text, match: op.create.keyword.matchType });
        return { resourceName };
      }
      if (service === "campaignCriteria" && op.remove) {
        s.negatives = s.negatives.filter((n) => n.resourceName !== op.remove);
        return { resourceName: op.remove };
      }
      const u = op.update;
      if (!u) throw new Error(`Unsupported demo operation on ${service}`);
      if (service === "campaigns") s.campaignStatus[id(u.resourceName)] = u.status;
      else if (service === "adGroups") s.adGroupStatus[id(u.resourceName)] = u.status;
      else if (service === "adGroupCriteria") s.keywordStatus[id(u.resourceName).split("~")[1]!] = u.status;
      else if (service === "campaignBudgets") s.budget[id(u.resourceName)] = Number(u.amountMicros) / 1e6;
      else throw new Error(`Unsupported demo operation on ${service}`);
      return { resourceName: u.resourceName };
    });
    if (!opts.validateOnly) this.save(s);
    return { results: opts.validateOnly ? [] : results };
  }
}

// ---------------------------------------------------------------- a small GAQL reader

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const get = (row: any, path: string[]) => path.reduce((o, k) => (o == null ? undefined : o[k]), row);
const lit = (v: string): string | number => {
  const t = v.trim();
  if (/^'.*'$|^".*"$/.test(t)) return t.slice(1, -1);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t.toUpperCase() === "TRUE" ? 1 : t.toUpperCase() === "FALSE" ? 0 : t;
};
const norm = (v: unknown): string | number => (typeof v === "boolean" ? Number(v) : typeof v === "number" ? v
  : v != null && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v ?? ""));
const cmp = (a: unknown, b: unknown) => { const x = norm(a), y = norm(b); return x < y ? -1 : x > y ? 1 : 0; };

function parse(query: string) {
  const q = query.replace(/\s+/g, " ").trim();
  const from = /\bFROM\s+(\w+)/i.exec(q)?.[1]?.toLowerCase();
  if (!from) throw new Error("GAQL query needs a FROM clause");
  const where = /\bWHERE\s+(.+?)(?:\s+ORDER BY\s+|\s+LIMIT\s+|$)/i.exec(q)?.[1] ?? "";
  const orderBy = /\bORDER BY\s+([\w.]+)(?:\s+(ASC|DESC))?/i.exec(q);
  const limit = Number(/\bLIMIT\s+(\d+)/i.exec(q)?.[1] ?? 0) || undefined;
  let days = HISTORY_DAYS;
  const conds: ((r: any) => boolean)[] = [];
  // Split on AND outside quotes and outside BETWEEN … AND …
  const parts = where ? where.replace(/BETWEEN\s+('[^']*')\s+AND\s+('[^']*')/gi, "BETWEEN $1 && $2").split(/\s+AND\s+(?=(?:[^']*'[^']*')*[^']*$)/i) : [];
  for (const part of parts) {
    const p = part.trim();
    const dr = /^segments\.date\s+BETWEEN\s+'([\d-]+)'\s+&&\s+'([\d-]+)'$/i.exec(p);
    if (dr) { days = Math.round((Date.parse(dr[2]!) - Date.parse(dr[1]!)) / 86_400_000) + 1; continue; }
    const during = /^segments\.date\s+DURING\s+LAST_(\d+)_DAYS$/i.exec(p);
    if (during) { days = Number(during[1]); continue; }
    if (/^segments\./i.test(p)) continue;
    const m = /^([\w.]+)\s*(=|!=|<=|>=|<|>|NOT IN|IN|LIKE|NOT LIKE)\s*(.+)$/i.exec(p);
    if (!m) throw new Error(`The demo account can't read this condition: ${p}`);
    const path = m[1]!.split(".").map(camel);
    const op = m[2]!.toUpperCase();
    const raw = m[3]!;
    if (op === "IN" || op === "NOT IN") {
      const list = raw.replace(/^\(|\)$/g, "").split(",").map((x) => String(lit(x)));
      conds.push((r) => list.includes(String(norm(get(r, path)))) === (op === "IN"));
    } else if (op === "LIKE" || op === "NOT LIKE") {
      const re = new RegExp(`^${String(lit(raw)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
      conds.push((r) => re.test(String(get(r, path) ?? "")) === (op === "LIKE"));
    } else {
      const v = lit(raw);
      conds.push((r) => {
        const c = cmp(get(r, path), v);
        return op === "=" ? c === 0 : op === "!=" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
      });
    }
  }
  return { from, where: conds, orderBy: orderBy ? { path: orderBy[1]!.split(".").map(camel), desc: orderBy[2]?.toUpperCase() === "DESC" } : undefined, limit, days };
}
