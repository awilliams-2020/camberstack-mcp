/**
 * Everything one connected user can do, independent of MCP. The MCP tools in tools.ts are thin
 * wrappers over these methods, which keeps them testable with a fake Ads client.
 */
import { randomUUID } from "node:crypto";
import type { DB, ProposalRow, UserRow } from "./db.js";
import { now } from "./db.js";
import { decrypt } from "./crypto.js";
import {
  AdsClient, SearchConsoleClient, SearchConsoleNotGrantedError, micros, refreshGoogleToken, revokeGoogleToken,
  type GoogleCreds, type SearchAnalyticsRequest, type SearchAnalyticsRow, type UrlInspection,
} from "./google.js";
import { ACCOUNT_WINDOW_DAYS, PLAN_LIMIT_PREFIX, PRO_PRICE_LABEL, accountsLabel } from "./plans.js";
import { DEMO_CID, DEMO_NAME, DEMO_NOTE, DEMO_SITE, DemoAds, DemoSearchConsole } from "./demo.js";
import {
  ChangeSchema, MAX_CHANGES, PROPOSAL_TTL, inverseAfterApply, pendingOf, resolveChange, summarize,
  type Change, type ResolvedChange,
} from "./changes.js";

export interface Account {
  customerId: string;
  name: string;
  currency: string;
  manager: boolean;
  /** Header Google needs when the account is reached through a manager (MCC). */
  loginCustomerId: string | null;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

export interface SessionDeps {
  db: DB;
  baseUrl: string;
  google: GoogleCreds;
  encryptionKey: Buffer;
  /** Google Ads accounts each plan covers, over ACCOUNT_WINDOW_DAYS (config.ts). */
  freeAccounts: number;
  proAccounts: number;
  proEmails: Set<string>;
  /** Asks Stripe whether this user just paid; true when that made them Pro (billing.ts refreshPlan). */
  refreshPlan?: (userId: string) => Promise<boolean>;
  /** Signed per-user billing links (billing.ts); null when billing isn't configured. */
  billingLink?: (kind: "upgrade" | "billing", userId: string) => string | null;
  /** Tests inject a fake. */
  adsFactory?: (user: UserRow) => AdsClient;
  scFactory?: (user: UserRow) => SearchConsole;
}

export class NotConnectedError extends Error {}

/** The Google Ads calls the tools make; the demo account answers the same ones. */
type Ads = Pick<AdsClient, "listAccessibleCustomers" | "search" | "mutate" | "keywordPlan">;

/** Sends the demo account's calls to the demo and everything else to Google. */
function routed(google: Ads, demo: DemoAds): Ads {
  return {
    listAccessibleCustomers: () => google.listAccessibleCustomers(),
    search: (cid, query, login) => (cid === DEMO_CID ? demo.search(cid, query) : google.search(cid, query, login)),
    mutate: (cid, service, ops, opts) => (cid === DEMO_CID ? demo.mutate(cid, service, ops, opts) : google.mutate(cid, service, ops, opts)),
    keywordPlan: (cid, method, req, login) => (cid === DEMO_CID ? demo.keywordPlan(cid, method, req) : google.keywordPlan(cid, method, req, login)),
  };
}

/** The Search Console calls the tools make; the demo site answers the same ones. */
type SearchConsole = Pick<SearchConsoleClient, "sites" | "searchAnalytics" | "sitemaps" | "inspect">;

function routedSc(google: SearchConsole, demo: DemoSearchConsole): SearchConsole {
  return {
    sites: () => google.sites(),
    searchAnalytics: (site, req) => (site === DEMO_SITE ? demo.searchAnalytics(site, req) : google.searchAnalytics(site, req)),
    sitemaps: (site) => (site === DEMO_SITE ? demo.sitemaps() : google.sitemaps(site)),
    inspect: (site, url) => (site === DEMO_SITE ? demo.inspect(site, url) : google.inspect(site, url)),
  };
}
const DEMO_SITE_NOTE = "Sample data from Camberstack's demo website (a fictional plumbing business), not a real Search Console property.";
const siteNote = (site: string) => (site === DEMO_SITE ? { note: DEMO_SITE_NOTE } : {});
/** Search terms and queries compared case- and spacing-insensitively. */
const norm = (q: string) => q.toLowerCase().trim().replace(/\s+/g, " ");

const DEMO_ACCOUNT: Account = { customerId: DEMO_CID, name: DEMO_NAME, currency: "USD", manager: false, loginCustomerId: null };
/** Customer ids arrive with or without dashes; stored and compared without. */
const bareCid = (customerId: string) => customerId.replace(/-/g, "");
export const isDemo = (customerId: string | null | undefined) => bareCid(customerId ?? "") === DEMO_CID;
/** Spread into any result about an account, so the AI can't mistake demo data for the user's. */
const demoNote = (customerId: string) => (isDemo(customerId) ? { note: DEMO_NOTE } : {});

type Outcome = { describe: string; ok: boolean; error?: string; inverse?: Change };
/** What the AI (and the account page) sees of an applied proposal's outcomes. */
const publicResults = (outcomes: Outcome[]) => outcomes.map(({ describe, ok, error }) => ({ change: describe, ok, ...(error ? { error } : {}) }));

export class UserSession {
  readonly ads: Ads;
  readonly sc: SearchConsole;
  private accountsCache?: { at: number; list: Account[] };
  /** Accounts the login can see but Google refused to read, from the last accounts() call. */
  lastUnreadable: { customerId: string; error: string }[] = [];

  constructor(private deps: SessionDeps, readonly user: UserRow) {
    const google = deps.adsFactory?.(user) ?? new AdsClient(() => this.googleAccessToken(), deps.google.developerToken);
    this.ads = routed(google, new DemoAds(deps.db, user.id));
    this.sc = routedSc(deps.scFactory?.(user) ?? new SearchConsoleClient(() => this.googleAccessToken()), new DemoSearchConsole());
  }

  static load(deps: SessionDeps, userId: string): UserSession {
    const user = deps.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!user) throw new NotConnectedError("Unknown user; connect Camberstack again.");
    deps.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), userId);
    return new UserSession(deps, user);
  }

  /** An access token for this user's Google connection (cached; refreshed from the stored refresh token). */
  async googleAccessToken(): Promise<string> {
    const hit = tokenCache.get(this.user.id);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    if (!this.user.enc_refresh) throw new NotConnectedError("Google Ads is disconnected. Reconnect Camberstack in your AI app.");
    try {
      const t = await refreshGoogleToken(this.deps.google, decrypt(this.deps.encryptionKey, this.user.enc_refresh));
      tokenCache.set(this.user.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
      return t.access_token;
    } catch (e) {
      if ((e as { revoked?: boolean }).revoked) {
        this.forgetGoogle();
        throw new NotConnectedError("Google access was revoked. Reconnect Camberstack in your AI app.");
      }
      throw e;
    }
  }

  get isPro(): boolean {
    return this.user.plan === "pro" || this.deps.proEmails.has(this.user.email.toLowerCase());
  }

  get accountLimit(): number {
    return this.isPro ? this.deps.proAccounts : this.deps.freeAccounts;
  }

  /**
   * Google Ads accounts this user has run tools on in the window: what a plan is sized by. Accounts used,
   * not accounts reachable, so a manager login that can see 50 clients isn't charged for 50. The demo never
   * counts, and nor do failed calls (a call the gate refused is logged as failed).
   */
  accountsInUse(): string[] {
    return (this.deps.db.prepare(`SELECT DISTINCT customer_id c FROM tool_calls
        WHERE user_id = ? AND ok = 1 AND customer_id IS NOT NULL AND customer_id != ? AND at >= ?`)
      .all(this.user.id, DEMO_CID, now() - ACCOUNT_WINDOW_DAYS * 86400) as { c: string }[]).map((r) => r.c);
  }

  /**
   * The plan gate, run before every tool that reads or proposes on a Google Ads account. An account already
   * in use always passes, so the gate only ever stops a NEW account. Manager accounts don't count: they are
   * how a login reaches its clients, not an account anyone advertises from. Undo, history and billing take
   * no account and are never gated: nothing may stand between a user and reversing a change.
   */
  async checkAccount(customerId: string): Promise<void> {
    const cid = bareCid(customerId);
    if (isDemo(cid)) return;
    const used = this.accountsInUse();
    if (used.includes(cid) || used.length < this.accountLimit) return;
    const managers = new Set((await this.accounts().catch(() => [] as Account[])).filter((a) => a.manager).map((a) => a.customerId));
    if (managers.has(cid)) return;
    const counted = used.filter((c) => !managers.has(c));
    if (counted.length < this.accountLimit) return;
    // Someone who paid and closed the tab before /upgraded must not be blocked for an hour: ask Stripe first.
    if (!this.isPro && await this.deps.refreshPlan?.(this.user.id)) {
      this.user.plan = "pro";
      if (counted.length < this.accountLimit) return;
    }
    const window = `in the last ${ACCOUNT_WINDOW_DAYS} days`;
    if (this.isPro) {
      throw new Error(`${PLAN_LIMIT_PREFIX} Camberstack has been used on ${accountsLabel(counted.length)} ${window}; Pro covers ${this.deps.proAccounts}. `
        + `Accounts drop out ${ACCOUNT_WINDOW_DAYS} days after their last use. For more, the user can email adam@camberstack.io.`);
    }
    const url = this.deps.billingLink?.("upgrade", this.user.id);
    throw new Error(`${PLAN_LIMIT_PREFIX} Camberstack has been used on ${accountsLabel(counted.length)} ${window} (${counted.join(", ")}); `
      + `the Free plan covers ${this.deps.freeAccounts}. Camberstack Pro (${PRO_PRICE_LABEL}, cancel any time) covers up to ${this.deps.proAccounts}. `
      + (url ? `Show the user this personal upgrade link: ${url} — then try again once they have paid. ` : `Upgrades open soon; see ${this.deps.baseUrl}/#pricing. `)
      + `Otherwise keep using the account already in use; an account drops out ${ACCOUNT_WINDOW_DAYS} days after its last use. Undo and change history always work.`);
  }

  plan() {
    const upgrade = this.deps.billingLink?.("upgrade", this.user.id) ?? null;
    const account_page = `${this.deps.baseUrl}/account`;
    const usage = { accounts_in_use: this.accountsInUse(), accounts_included: this.accountLimit, window_days: ACCOUNT_WINDOW_DAYS };
    return this.isPro
      ? { plan: "pro", account_page, ...usage,
          // Paid Pro is plan = 'pro' (a live subscription). Pro any other way is complimentary (PRO_EMAILS):
          // nothing to manage or cancel, even if an old Stripe customer is still on record.
          ...(this.user.plan === "pro" && this.user.stripe_customer
            ? { manage_billing: this.deps.billingLink?.("billing", this.user.id) ?? null }
            : { complimentary: true, manage_billing: null }) }
      : { plan: "free", account_page, ...usage,
          included: "every tool on 1 Google Ads account, with unlimited applied changes; undo and history always work",
          pro: `up to ${accountsLabel(this.deps.proAccounts)}, ${PRO_PRICE_LABEL}, cancel any time`, upgrade_url: upgrade,
          note: upgrade ? "Show the user upgrade_url as a link; it is personal and expires in 7 days." : "Upgrades are not open yet." };
  }

  // ---------------------------------------------------------------- read

  async accounts(): Promise<Account[]> {
    if (this.accountsCache && Date.now() - this.accountsCache.at < 10 * 60_000) return this.accountsCache.list;
    const out = new Map<string, Account>();
    const unreadable: { customerId: string; error: string }[] = [];
    let roots: string[] = [];
    try {
      roots = await this.ads.listAccessibleCustomers();
    } catch (e) {
      // A login with no Google Ads at all (NOT_ADS_USER) gets the demo account instead of a dead end.
      if (e instanceof NotConnectedError) throw e;
      unreadable.push({ customerId: "this Google login", error: (e as Error).message });
    }
    for (const root of roots) {
      let rows: any[] = [];
      try {
        rows = await this.ads.search(root, `SELECT customer_client.id, customer_client.descriptive_name,
            customer_client.currency_code, customer_client.manager, customer_client.level, customer_client.status
          FROM customer_client WHERE customer_client.level <= 1 AND customer_client.status = 'ENABLED'`, root);
      } catch (e) {
        // One cancelled account shouldn't hide the rest, but the reason must never be swallowed:
        // an empty list that is really an API refusal reads as "you have no accounts".
        unreadable.push({ customerId: root, error: (e as Error).message });
        continue;
      }
      for (const r of rows) {
        const c = r.customerClient;
        const cid = String(c.id);
        const viaSelf = cid === root;
        if (out.has(cid) && !viaSelf) continue;
        out.set(cid, {
          customerId: cid,
          name: c.descriptiveName ?? "(unnamed)",
          currency: c.currencyCode ?? "",
          manager: !!c.manager,
          loginCustomerId: viaSelf ? null : root,
        });
      }
    }
    const list = [...out.values()].sort((a, b) => Number(a.manager) - Number(b.manager) || a.name.localeCompare(b.name));
    // Nothing readable (no Ads access, or blocked e.g. by 2-Step Verification): offer the demo account,
    // and keep the reason in lastUnreadable so list_accounts still says why the real ones are missing.
    if (!list.some((a) => !a.manager)) list.push(DEMO_ACCOUNT);
    this.lastUnreadable = unreadable;
    this.accountsCache = { at: Date.now(), list };
    return list;
  }

  async account(customerId: string): Promise<Account> {
    const cid = bareCid(customerId);
    if (cid === DEMO_CID) return DEMO_ACCOUNT;  // anyone can try the demo by its id
    const a = (await this.accounts()).find((x) => x.customerId === cid);
    if (!a) throw new Error(`Account ${customerId} is not accessible with this Google login. Call list_accounts to see the ones that are.`);
    if (a.manager) throw new Error(`${a.name} (${cid}) is a manager account; pick one of the client accounts under it.`);
    return a;
  }

  async overview(customerId: string, days: number) {
    const a = await this.account(customerId);
    const rows = await this.ads.search(a.customerId, `SELECT campaign.id, campaign.name, campaign.status,
        campaign.advertising_channel_type, campaign_budget.amount_micros, campaign.bidding_strategy_type,
        metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
      FROM campaign WHERE ${dateRange(days)} AND campaign.status != 'REMOVED'`, a.loginCustomerId);
    const summed = aggregate(rows, (r) => String(r.campaign.id), (r) => ({
      campaign_id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status, type: r.campaign.advertisingChannelType,
      bidding: r.campaign.biddingStrategyType, daily_budget: micros(r.campaignBudget?.amountMicros),
      cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0,
    }), (e, r) => {
      e.impressions += Number(r.metrics?.impressions ?? 0);
      e.conversion_value += Number(r.metrics?.conversionsValue ?? 0);
    });
    const campaigns = summed.map((c) => ({
      ...c, cost: round(c.cost), conversions: round(c.conversions),
      cost_per_conversion: c.conversions > 0 ? round(c.cost / c.conversions) : null,
    })).sort((x, y) => y.cost - x.cost);
    const cost = campaigns.reduce((s, c) => s + c.cost, 0);
    const conv = campaigns.reduce((s, c) => s + c.conversions, 0);
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      window: `last ${days} days`,
      totals: { cost: round(cost), conversions: round(conv), cost_per_conversion: conv > 0 ? round(cost / conv) : null },
      campaigns,
    };
  }

  async runQuery(customerId: string, query: string) {
    if (!/^\s*select\b/i.test(query)) throw new Error("Only SELECT (read-only GAQL) queries are allowed. Use propose_changes to change anything.");
    const a = await this.account(customerId);
    const rows = await this.ads.search(a.customerId, query, a.loginCustomerId);
    return { ...demoNote(a.customerId), rows: rows.slice(0, 500), truncated: rows.length > 500, total_rows: rows.length };
  }

  /** Keyword Planner ideas from seed keywords and/or a URL, biggest first, flagged where the account already has them. */
  async keywordIdeas(customerId: string, o: KeywordPlanOpts & { keywords?: string[]; url?: string; min_searches: number; limit: number }) {
    const a = await this.account(customerId);
    const keywords = [...new Set((o.keywords ?? []).map((k) => k.trim()).filter(Boolean))];
    if (!keywords.length && !o.url) throw new Error("Give at least one seed keyword or a URL.");
    const seed = keywords.length && o.url ? { keywordAndUrlSeed: { keywords, url: o.url } }
      : keywords.length ? { keywordSeed: { keywords } } : { urlSeed: { url: o.url } };
    const [res, have] = await Promise.all([
      this.ads.keywordPlan(a.customerId, "generateKeywordIdeas", { ...planTarget(o), includeAdultKeywords: false, ...seed }, a.loginCustomerId),
      this.keywordsInAccount(a),
    ]);
    const ideas = (res.results ?? [])
      .map((r) => keywordRow(r.text, r.keywordIdeaMetrics, have))
      .filter((k) => k.avg_monthly_searches !== null && k.avg_monthly_searches >= o.min_searches)
      .sort((x, y) => y.avg_monthly_searches! - x.avg_monthly_searches!);
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      target: { location_ids: o.location_ids, language_id: o.language_id },
      ideas: ideas.slice(0, o.limit), total_ideas: ideas.length,
    };
  }

  /** Keyword Planner volume, competition and bids for an exact list, with the last 12 months of searches. */
  async keywordMetrics(customerId: string, o: KeywordPlanOpts & { keywords: string[] }) {
    const a = await this.account(customerId);
    const keywords = [...new Set(o.keywords.map((k) => k.trim()).filter(Boolean))];
    const [res, have] = await Promise.all([
      this.ads.keywordPlan(a.customerId, "generateKeywordHistoricalMetrics", { ...planTarget(o), includeAdultKeywords: false, keywords }, a.loginCustomerId),
      this.keywordsInAccount(a),
    ]);
    const rows = (res.results ?? []).map((r) => ({
      ...keywordRow(r.text, r.keywordMetrics, have),
      ...(r.closeVariants?.length ? { close_variants: r.closeVariants } : {}),
      monthly: monthly(r.keywordMetrics?.monthlySearchVolumes),
    }));
    // Google omits keywords it has no data for; say so rather than dropping them silently.
    const covered = new Set(rows.flatMap((r) => [r.keyword, ...(r.close_variants ?? [])].map((k: string) => k.toLowerCase())));
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      ...demoNote(a.customerId),
      target: { location_ids: o.location_ids, language_id: o.language_id },
      keywords: rows,
      no_data: keywords.filter((k) => !covered.has(k.toLowerCase())),
    };
  }

  /** Lowercased keyword text → "keyword" or "negative", across the whole account. */
  private async keywordsInAccount(a: Account): Promise<Map<string, "keyword" | "negative">> {
    const [kw, neg] = await Promise.all([
      this.ads.search(a.customerId, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.negative
        FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT campaign_criterion.keyword.text
        FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = true`, a.loginCustomerId),
    ]);
    const m = new Map<string, "keyword" | "negative">();
    for (const r of kw) {
      const t = r.adGroupCriterion?.keyword?.text?.toLowerCase();
      if (t) m.set(t, r.adGroupCriterion.negative ? "negative" : "keyword");
    }
    for (const r of neg) {
      const t = r.campaignCriterion?.keyword?.text?.toLowerCase();
      if (t && !m.has(t)) m.set(t, "negative");
    }
    return m;
  }

  // ---------------------------------------------------------------- Search Console (read-only)

  /** Search Console properties this login can read; the demo site only when there are none. */
  async searchConsoleSites() {
    let sites: { siteUrl: string; permissionLevel: string }[];
    try {
      sites = (await this.sc.sites()).filter((x) => x.permissionLevel !== "siteUnverifiedUser");
    } catch (e) {
      if (!(e instanceof SearchConsoleNotGrantedError)) throw e;
      return { sites: [{ site_url: DEMO_SITE, permission: "demo" }], not_granted: e.message,
        note: "Only the demo site is available until the user grants Search Console access. Say so plainly." };
    }
    if (sites.length) return { sites: sites.map((x) => ({ site_url: x.siteUrl, permission: x.permissionLevel })) };
    return { sites: [{ site_url: DEMO_SITE, permission: "demo" }],
      note: "This Google login has no verified Search Console property, so the demo site (sample data) is offered. Tell the user it is a demo." };
  }

  /**
   * Site-wide totals for the window and for the same number of days before it. With no dimension Google returns the
   * site's true totals, including the rare queries it leaves out of per-query rows.
   */
  async searchConsoleSummary(site: string, o: ScWindowOpts) {
    const cur = scWindow(o);
    const prev = priorWindow(cur);
    const [now_, before] = await Promise.all([this.scTotals(site, cur, o.fresh), this.scTotals(site, prev, o.fresh)]);
    const pct = (a: number, b: number) => (b > 0 ? round(((a - b) / b) * 100) : null);
    return {
      site, ...siteNote(site),
      current: { window: cur, ...now_ }, previous: { window: prev, ...before },
      change: {
        clicks_pct: pct(now_.clicks, before.clicks), impressions_pct: pct(now_.impressions, before.impressions),
        ctr_points: round(now_.ctr_pct - before.ctr_pct),
        position: now_.position != null && before.position != null ? Math.round((now_.position - before.position) * 10) / 10 : null,
      },
      note: "A lower position is better: a negative position change means the site moved up."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /** Undimensioned site totals: the only figure that includes the rare queries Google withholds from per-query rows. */
  private async scTotals(site: string, w: { start: string; end: string }, fresh?: boolean) {
    const [r] = await this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: [], rowLimit: 1, ...dataState(fresh) });
    return r ? organicMetrics(r) : { clicks: 0, impressions: 0, ctr_pct: 0, position: null };
  }

  /** Every row for one dimension, paging past Google's 25,000-row cap (up to SC_MAX_ROWS) so "lost" means lost, not truncated. */
  private async scAllRows(site: string, req: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">) {
    const out: SearchAnalyticsRow[] = [];
    for (let startRow = 0; startRow < SC_MAX_ROWS; startRow += 25_000) {
      const rows = await this.sc.searchAnalytics(site, { ...req, rowLimit: 25_000, startRow });
      out.push(...rows);
      if (rows.length < 25_000) return { rows: out, truncated: false };
    }
    return { rows: out, truncated: true };
  }

  /** Search performance (clicks, impressions, CTR, position) grouped by the given dimensions, most clicks first. */
  async searchConsolePerformance(site: string, o: ScWindowOpts & ScFilterOpts & { dimensions: string[]; limit: number }) {
    const w = scWindow(o);
    const filters = scFilters(o);
    const rows = await this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: o.dimensions, rowLimit: o.limit,
      ...dataState(o.fresh), ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}) });
    return {
      site, ...siteNote(site), window: w,
      rows: rows.map((r) => ({ ...Object.fromEntries(o.dimensions.map((d, i) => [d, r.keys[i]])), ...organicMetrics(r) })),
      note: "Search Console leaves out rare queries for privacy, so query rows don't add up to the site's total clicks."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Two adjacent equal windows, compared query by query and page by page: what is rising, falling, new and gone,
   * and rising searches the site is sliding down on. Totals come from undimensioned requests, not row sums.
   */
  async searchConsoleTrend(site: string, o: ScWindowOpts & { exclude_query_regex?: string; min_impressions: number; limit: number }) {
    const cur = scWindow(o);
    const prev = priorWindow(cur);
    const exclude = o.exclude_query_regex ? { dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] }] } : {};
    const pull = (w: { start: string; end: string }, dim: string) =>
      this.scAllRows(site, { startDate: w.start, endDate: w.end, dimensions: [dim], ...dataState(o.fresh), ...(dim === "query" ? exclude : {}) });
    const [qCur, qPrev, pCur, pPrev, tCur, tPrev] = await Promise.all([
      pull(cur, "query"), pull(prev, "query"), pull(cur, "page"), pull(prev, "page"),
      this.scTotals(site, cur, o.fresh), this.scTotals(site, prev, o.fresh),
    ]);
    const queries = diffWindows(qCur.rows, qPrev.rows, o.min_impressions);
    const pages = diffWindows(pCur.rows, pPrev.rows, o.min_impressions);
    const moving = queries.filter((r) => !r.state);
    const up = (a: TrendRow, b: TrendRow) => b.impressions_change - a.impressions_change;
    const down = (a: TrendRow, b: TrendRow) => a.impressions_change - b.impressions_change;
    const pct = (a: number, b: number) => (b > 0 ? round(((a - b) / b) * 100) : null);
    return {
      site, ...siteNote(site), current_window: cur, prior_window: prev,
      totals: { current: tCur, prior: tPrev, impressions_pct: pct(tCur.impressions, tPrev.impressions), clicks_pct: pct(tCur.clicks, tPrev.clicks) },
      counts: { queries_current: qCur.rows.length, queries_prior: qPrev.rows.length, compared: queries.length,
        new: queries.filter((r) => r.state === "new").length, lost: queries.filter((r) => r.state === "lost").length },
      ...(qCur.truncated || qPrev.truncated ? { truncated: `More than ${SC_MAX_ROWS} queries in a window; the rest weren't compared.` } : {}),
      rising_queries: moving.filter((r) => r.impressions_change > 0).sort(up).slice(0, o.limit),
      falling_queries: moving.filter((r) => r.impressions_change < 0).sort(down).slice(0, o.limit),
      new_queries: queries.filter((r) => r.state === "new").sort(up).slice(0, o.limit),
      lost_queries: queries.filter((r) => r.state === "lost").sort(down).slice(0, o.limit),
      losing_ground: moving.filter((r) => r.impressions_change > 0 && (r.position_change ?? 0) > 0.5).sort(up).slice(0, o.limit),
      rising_pages: pages.filter((r) => r.impressions_change > 0).sort(up).slice(0, o.limit),
      falling_pages: pages.filter((r) => r.impressions_change < 0).sort(down).slice(0, o.limit),
      how_to_read: `Rows need at least ${o.min_impressions} impressions in one of the windows. A negative position_change means the site moved up. `
        + "losing_ground: searches growing while the site's position gets worse. Adjacent windows mix trend with seasonality, so check "
        + "anything seasonal against the same dates a year earlier. A page that falls while a near-identical URL (trailing slash, www, "
        + "http) rises is Google consolidating duplicates, not lost demand: check it with search_console_inspect_urls before acting."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Where more clicks are within reach: queries on positions 4-20 with real impressions (projected to a realistic climb),
   * top-5 queries whose CTR is under half of what that position usually gets (a title/description problem), and
   * question-shaped queries. Projections use a typical CTR-by-position curve, not the site's own.
   */
  async searchConsoleOpportunities(site: string, o: ScWindowOpts & { exclude_query_regex?: string; limit: number }) {
    const w = scWindow(o);
    const { rows } = await this.scAllRows(site, { startDate: w.start, endDate: w.end, dimensions: ["query"], ...dataState(o.fresh),
      ...(o.exclude_query_regex ? { dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] }] } : {}) });
    const q = (r: SearchAnalyticsRow) => ({ query: r.keys[0], ...organicMetrics(r) });
    const striking = rows.filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 15).map((r) => {
      const target = Math.max(3, Math.floor(r.position) - 3);
      const projected = r.impressions * ctrAt(target);
      return { ...q(r), target_position: target, projected_clicks: round(projected), click_gain: round(projected - r.clicks) };
    }).sort((a, b) => b.click_gain - a.click_gain);
    const snippet = rows.filter((r) => r.position <= 5 && r.impressions >= 30 && r.ctr < ctrAt(r.position) * 0.5)
      .map((r) => ({ ...q(r), typical_ctr_pct: round(ctrAt(r.position) * 100), click_gain: round(r.impressions * ctrAt(r.position) - r.clicks) }))
      .sort((a, b) => b.click_gain - a.click_gain);
    const questions = rows.filter((r) => QUESTION.test(r.keys[0] ?? "") && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions).map(q);
    return {
      site, ...siteNote(site), window: w,
      striking_distance: striking.slice(0, o.limit), striking_distance_total: striking.length,
      snippet_gaps: snippet.slice(0, o.limit), snippet_gaps_total: snippet.length,
      question_queries: questions.slice(0, o.limit), question_queries_total: questions.length,
      how_to_read: "striking_distance: positions 4-20 with 15+ impressions; click_gain assumes a climb of about 3 places (not to #1). "
        + "snippet_gaps: top-5 positions with 30+ impressions but under half the usual CTR there: rewrite the title and meta description, "
        + "or check for a missing rich result. question_queries: question- and comparison-shaped searches, the kind answer boxes and AI "
        + "answers draw on. Expected CTRs are industry averages, so treat click_gain as a ranking of opportunities, not a forecast. "
        + "Empty lists are a finding: nothing is close enough for a quick win. Exclude the brand name with exclude_query_regex."
        + (o.fresh ? " " + FRESH_NOTE : ""),
    };
  }

  /**
   * Google's index record for each URL: indexed or not and why, last crawl, canonical chosen vs declared, and
   * structured-data items. One call per URL, a few at a time (Google allows 600 a minute, 2,000 a day per property).
   */
  async searchConsoleInspectUrls(site: string, urls: string[]) {
    const results: Record<string, unknown>[] = new Array(urls.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < urls.length; i = next++) {
        try { results[i] = inspectionRow(urls[i]!, await this.sc.inspect(site, urls[i]!)); }
        catch (e) {
          if (e instanceof SearchConsoleNotGrantedError) throw e;
          results[i] = { url: urls[i], error: (e as Error).message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, urls.length) }, worker));
    const tally: Record<string, number> = {};
    for (const r of results) { const k = String(r.coverage_state ?? (r.error ? "error" : "unknown")); tally[k] = (tally[k] ?? 0) + 1; }
    return {
      site, ...siteNote(site), tally, results,
      note: "Each verdict describes Google's last crawl (last_crawl), not the live page: a fix made after that date still shows the old state. "
        + "\"Discovered - currently not indexed\" means Google knows the URL but hasn't spent a crawl on it; \"Crawled - currently not indexed\" "
        + "means it crawled and declined. Google's index-coverage report in the Search Console UI lags this by days. Requesting indexing "
        + "and submitting sitemaps can only be done in Search Console itself.",
    };
  }

  /** Sitemaps submitted for the property: when Google last fetched each, URL counts and error/warning counts. Read-only. */
  async searchConsoleSitemaps(site: string) {
    const list = await this.sc.sitemaps(site);
    return {
      site, ...siteNote(site),
      sitemaps: list.map((m) => ({
        path: m.path, last_submitted: m.lastSubmitted ?? null, last_downloaded: m.lastDownloaded ?? null, pending: m.isPending ?? false,
        index: m.isSitemapsIndex ?? false, errors: Number(m.errors ?? 0), warnings: Number(m.warnings ?? 0),
        urls_submitted: (m.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0),
      })),
      note: list.length ? "Submitting or resubmitting a sitemap can only be done in Search Console itself."
        : "No sitemap is submitted for this property. The user can submit one in Search Console (Indexing > Sitemaps).",
    };
  }

  /**
   * Ads search terms joined with the same site's organic queries over the same days: searches the account pays for
   * where the site already ranks near the top, and searches the site ranks on page 2+ for with no ads at all.
   */
  async paidOrganicOverlap(customerId: string, site: string, o: { days: number; max_position: number; min_impressions: number; limit: number }) {
    const a = await this.account(customerId);
    const w = searchConsoleWindow(o.days);
    const [terms, organic, have] = await Promise.all([
      this.ads.search(a.customerId, `SELECT search_term_view.search_term, campaign.id, campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM search_term_view WHERE segments.date BETWEEN '${w.start}' AND '${w.end}'`, a.loginCustomerId),
      this.sc.searchAnalytics(site, { startDate: w.start, endDate: w.end, dimensions: ["query"], rowLimit: 25000 }),
      this.keywordsInAccount(a),
    ]);
    const paid = new Map(aggregate(terms, (r) => norm(String(r.searchTermView?.searchTerm ?? "")),
      (r) => ({ term: norm(String(r.searchTermView?.searchTerm ?? "")), cost: 0, clicks: 0, conversions: 0, campaigns: new Set<string>() }),
      (e, r) => { if (r.campaign?.name) e.campaigns.add(String(r.campaign.name)); })
      .filter((e) => e.term && e.cost > 0).map((e) => [e.term, e]));

    const paidAndRanking = organic.flatMap((r) => {
      const p = paid.get(norm(r.keys[0] ?? ""));
      return p && r.position <= o.max_position ? [{
        query: r.keys[0], organic_position: Math.round(r.position * 10) / 10, organic_clicks: r.clicks, organic_impressions: r.impressions,
        ad_cost: round(p.cost), ad_clicks: p.clicks, ad_conversions: round(p.conversions), campaigns: [...p.campaigns],
      }] : [];
    }).sort((x, y) => y.ad_cost - x.ad_cost);

    const organicGaps = organic.flatMap((r) => {
      const q = norm(r.keys[0] ?? "");
      return r.position > 10 && r.impressions >= o.min_impressions && !paid.has(q) && !have.has(q)
        ? [{ query: r.keys[0], ...organicMetrics(r) }] : [];
    }).sort((x, y) => y.impressions - x.impressions);

    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      site, ...demoNote(a.customerId), ...siteNote(site), window: w,
      paid_and_ranking: paidAndRanking.slice(0, o.limit),
      paid_and_ranking_total: { queries: paidAndRanking.length, ad_cost: round(paidAndRanking.reduce((s, x) => s + x.ad_cost, 0)) },
      organic_gaps: organicGaps.slice(0, o.limit), organic_gaps_total: organicGaps.length,
      how_to_use: `paid_and_ranking: searches the account pays for where the site already averages position ${o.max_position} or better organically. `
        + "Ads sit above organic results and brand terms defend against competitors, so don't cut them all: suggest testing one at a time "
        + "(set_keyword_bid lower, or add_negative_keywords) and comparing total clicks before and after. "
        + "organic_gaps: searches the site shows up for on page 2 or lower with no ad and no keyword in the account; check them with "
        + "keyword_metrics, then add_keywords or add_ad_group through propose_changes. Search Console leaves out rare queries, so both lists are partial.",
    };
  }

  // ---------------------------------------------------------------- write

  async propose(customerId: string, rawChanges: unknown[], undoOf?: string): Promise<{ proposal_id: string; summary: string; changes: number; skipped: string[] }> {
    const a = await this.account(customerId);
    const changes: Change[] = rawChanges.map((c) => ChangeSchema.parse(c));
    const count = changes.reduce((n, c) => n + (c.type === "add_negative_keywords" || c.type === "add_keywords" ? c.keywords.length : 1), 0);
    if (count > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes per proposal (got ${count}). Split it.`);
    const resolved: ResolvedChange[] = [];
    const pending = pendingOf(changes);
    for (const c of changes) resolved.push(await resolveChange(this.ads, a.customerId, a.loginCustomerId, c, pending));
    const live = resolved.filter((r) => r.operations.length);
    if (!live.length) throw new Error("Nothing to change: every requested change is already in place.");
    // Dry run against Google so problems surface now, not after the user approves.
    for (const r of live) await this.ads.mutate(a.customerId, r.service, r.operations, { validateOnly: true, loginCustomerId: a.loginCustomerId });
    const id = `p_${randomUUID().slice(0, 8)}`;
    const summary = summarize(live);
    this.deps.db.prepare(`INSERT INTO proposals (id, user_id, customer_id, login_customer_id, changes, summary, status, undo_of, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`)
      .run(id, this.user.id, a.customerId, a.loginCustomerId, JSON.stringify(live.map((r) => r.change)), summary, undoOf ?? null, now());
    const skipped = resolved.filter((r) => !r.operations.length).map((r) => r.describe);
    return { proposal_id: id, summary, changes: live.length, skipped };
  }

  async apply(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "proposed") throw new Error(`Proposal ${proposalId} is already ${p.status}.`);
    if (p.created_at < now() - PROPOSAL_TTL) throw new Error(`Proposal ${proposalId} is older than 24 hours; the account may have changed. Propose again.`);
    const changes = JSON.parse(p.changes) as Change[];
    const pending = pendingOf(changes);
    const outcomes: Outcome[] = [];
    for (const c of changes) {
      let describe = c.type as string;
      try {
        // Re-resolve: the account may have moved since the proposal was made.
        const r = await resolveChange(this.ads, p.customer_id, p.login_customer_id, c, pending);
        describe = r.describe;
        if (!r.operations.length) { outcomes.push({ describe: `${describe} (already in place)`, ok: true }); continue; }
        const res = await this.ads.mutate(p.customer_id, r.service, r.operations, { loginCustomerId: p.login_customer_id });
        const names = (res.results ?? []).map((x) => x.resourceName).filter((x): x is string => !!x);
        outcomes.push({ describe, ok: true, inverse: inverseAfterApply(r, names) });
      } catch (e) {
        outcomes.push({ describe, ok: false, error: (e as Error).message });
      }
    }
    const allOk = outcomes.every((o) => o.ok);
    const anyOk = outcomes.some((o) => o.ok);
    this.deps.db.prepare("UPDATE proposals SET status = ?, result = ?, applied_at = ? WHERE id = ?")
      .run(anyOk ? "applied" : "failed", JSON.stringify(outcomes), now(), p.id);
    return {
      proposal_id: p.id,
      status: allOk ? "applied" : anyOk ? "partially applied" : "failed",
      results: publicResults(outcomes),
      undo: anyOk ? `To reverse this, call undo_changes with proposal_id "${p.id}".` : undefined,
    };
  }

  async undo(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "applied") throw new Error(`Only applied proposals can be undone (${proposalId} is ${p.status}).`);
    const outcomes = JSON.parse(p.result ?? "[]") as Outcome[];
    const inverses = outcomes.map((o) => o.inverse).filter((x): x is Change => !!x).reverse();
    if (!inverses.length) throw new Error("Nothing to undo: none of the changes in that proposal altered the account.");
    return this.propose(p.customer_id, inverses, p.id);
  }

  discard(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "proposed") throw new Error(`Proposal ${proposalId} is ${p.status}; only open proposals can be discarded.`);
    this.deps.db.prepare("UPDATE proposals SET status = 'discarded' WHERE id = ?").run(p.id);
    return { proposal_id: p.id, status: "discarded" };
  }

  history(customerId: string | undefined, limit: number) {
    const rows = (customerId
      ? this.deps.db.prepare("SELECT * FROM proposals WHERE user_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.user.id, bareCid(customerId), limit)
      : this.deps.db.prepare("SELECT * FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.user.id, limit)) as ProposalRow[];
    return rows.map((p) => ({
      proposal_id: p.id, customer_id: p.customer_id, status: p.status, summary: p.summary,
      proposed_at: new Date(p.created_at * 1000).toISOString(),
      applied_at: p.applied_at ? new Date(p.applied_at * 1000).toISOString() : null,
      undo_of: p.undo_of,
      results: p.result ? publicResults(JSON.parse(p.result) as Outcome[]) : undefined,
    }));
  }

  private forgetGoogle(): void {
    this.deps.db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = ?").run(this.user.id);
    tokenCache.delete(this.user.id);
  }

  private proposal(id: string): ProposalRow {
    const p = this.deps.db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(id, this.user.id) as ProposalRow | undefined;
    if (!p) throw new Error(`No proposal ${id} for this user.`);
    return p;
  }

  /** Revoke at Google, forget the refresh token and every token we issued. Change history is kept. */
  async disconnect() {
    if (this.user.enc_refresh) await revokeGoogleToken(decrypt(this.deps.encryptionKey, this.user.enc_refresh));
    this.forgetGoogle();
    this.deps.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(this.user.id);
    return { disconnected: true, note: "Google access revoked and stored credentials deleted. To delete your change history too, email adam@camberstack.io." };
  }
}

export interface KeywordPlanOpts { location_ids: string[]; language_id: string }

const planTarget = (o: KeywordPlanOpts) => ({
  language: `languageConstants/${o.language_id}`,
  geoTargetConstants: o.location_ids.map((id) => `geoTargetConstants/${id}`),
  keywordPlanNetwork: "GOOGLE_SEARCH",
});

/** One Keyword Planner result, bids in the account's currency; `metrics` is keywordIdeaMetrics or keywordMetrics. */
function keywordRow(text: string, metrics: any, have: Map<string, "keyword" | "negative">) {
  const bid = (m: unknown) => (m == null ? null : round(micros(m)));
  const inAccount = have.get(String(text).toLowerCase());
  return {
    keyword: String(text),
    avg_monthly_searches: metrics?.avgMonthlySearches == null ? null : Number(metrics.avgMonthlySearches),
    competition: metrics?.competition ?? null,
    top_of_page_bid: { low: bid(metrics?.lowTopOfPageBidMicros), high: bid(metrics?.highTopOfPageBidMicros) },
    ...(inAccount ? { in_account: inAccount } : {}),
  };
}

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
/** Last 12 months of searches as { "2026-08": 1900, ... }, oldest first. */
function monthly(volumes: { year?: number | string; month?: string; monthlySearches?: number | string }[] | undefined) {
  return Object.fromEntries((volumes ?? []).slice(-12).map((v) =>
    [`${v.year}-${String(MONTHS.indexOf(v.month ?? "") + 1).padStart(2, "0")}`, Number(v.monthlySearches ?? 0)]));
}

/**
 * Search Console's window: its last ~2 days are still incomplete, so it ends 3 days ago. The overlap tool reads the
 * Ads side over the same dates, so the two sides compare like for like.
 */
export function searchConsoleWindow(days: number, before = 0): { start: string; end: string } {
  const d = Math.max(1, Math.min(480, Math.floor(days)));
  const end = new Date(Date.now() - (3 + before) * 86_400_000);
  const start = new Date(end.getTime() - (d - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export interface ScWindowOpts { days: number; start_date?: string; end_date?: string; fresh?: boolean }
export interface ScFilterOpts { query_contains?: string; page_contains?: string; query_regex?: string; exclude_query_regex?: string; page_regex?: string }
const SC_MAX_ROWS = 100_000;
const FRESH_NOTE = "The window includes the last 2-3 days, which Google is still filling in, so recent days read low.";
const dataState = (fresh?: boolean): { dataState?: "all" } => (fresh ? { dataState: "all" } : {});
const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The window a Search Console tool reads: exact dates when both are given, otherwise the last `days` days ending 3 days ago
 * (or yesterday with fresh data). Google keeps about 16 months.
 */
export function scWindow(o: ScWindowOpts): { start: string; end: string } {
  if (o.start_date || o.end_date) {
    if (!o.start_date || !o.end_date) throw new Error("Pass both start_date and end_date, or neither (then days is used).");
    const a = Date.parse(o.start_date), b = Date.parse(o.end_date);
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("start_date and end_date must be real dates, YYYY-MM-DD.");
    if (a > b) throw new Error("start_date is after end_date.");
    if (b - a > 479 * DAY) throw new Error("A window can span at most 480 days; Search Console keeps about 16 months.");
    return { start: o.start_date, end: o.end_date };
  }
  if (!o.fresh) return searchConsoleWindow(o.days);
  const d = Math.max(1, Math.min(480, Math.floor(o.days)));
  const end = Date.now() - DAY;
  return { start: isoDay(end - (d - 1) * DAY), end: isoDay(end) };
}

/** The same number of days immediately before a window. */
export function priorWindow(w: { start: string; end: string }): { start: string; end: string } {
  const len = Date.parse(w.end) - Date.parse(w.start);
  const end = Date.parse(w.start) - DAY;
  return { start: isoDay(end - len), end: isoDay(end) };
}

/** Text and regex filters; regexes use Google's RE2 syntax, case-sensitive unless prefixed with (?i). */
function scFilters(o: ScFilterOpts) {
  return [
    ...(o.query_contains ? [{ dimension: "query", operator: "contains", expression: o.query_contains }] : []),
    ...(o.page_contains ? [{ dimension: "page", operator: "contains", expression: o.page_contains }] : []),
    ...(o.query_regex ? [{ dimension: "query", operator: "includingRegex", expression: o.query_regex }] : []),
    ...(o.exclude_query_regex ? [{ dimension: "query", operator: "excludingRegex", expression: o.exclude_query_regex }] : []),
    ...(o.page_regex ? [{ dimension: "page", operator: "includingRegex", expression: o.page_regex }] : []),
  ];
}

interface TrendRow {
  key: string; impressions: number; prior_impressions: number; impressions_change: number; impressions_pct: number | null;
  clicks: number; prior_clicks: number; position: number | null; prior_position: number | null; position_change: number | null;
  state?: "new" | "lost";
}
/** Per-key comparison of two windows; keys under minImpressions in both are noise (1 -> 3 is +200% and means nothing). */
function diffWindows(cur: SearchAnalyticsRow[], prev: SearchAnalyticsRow[], minImpressions: number): TrendRow[] {
  const c = new Map(cur.map((r) => [r.keys[0] ?? "", r])), p = new Map(prev.map((r) => [r.keys[0] ?? "", r]));
  const out: TrendRow[] = [];
  for (const key of new Set([...c.keys(), ...p.keys()])) {
    const a = c.get(key), b = p.get(key);
    const ai = a?.impressions ?? 0, bi = b?.impressions ?? 0;
    if (Math.max(ai, bi) < minImpressions) continue;
    const pos = (r?: SearchAnalyticsRow) => (r && r.impressions ? Math.round(r.position * 10) / 10 : null);
    out.push({
      key, impressions: ai, prior_impressions: bi, impressions_change: ai - bi, impressions_pct: bi > 0 ? round(((ai - bi) / bi) * 100) : null,
      clicks: a?.clicks ?? 0, prior_clicks: b?.clicks ?? 0, position: pos(a), prior_position: pos(b),
      position_change: ai && bi ? Math.round((a!.position - b!.position) * 10) / 10 : null,
      ...(bi === 0 ? { state: "new" as const } : ai === 0 ? { state: "lost" as const } : {}),
    });
  }
  return out;
}

/** Typical organic CTR by position (blended desktop and mobile); used only to rank opportunities. */
const CTR_BY_POSITION = [0.28, 0.15, 0.10, 0.07, 0.05, 0.04, 0.032, 0.026, 0.022, 0.019];
const ctrAt = (pos: number) => (pos <= 10 ? CTR_BY_POSITION[Math.max(1, Math.round(pos)) - 1]! : pos <= 20 ? 0.010 : 0.005);
const QUESTION = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b|\bvs\b|alternative|best|free|cost|price/i;

/** Google fills fields it has no answer for with *_UNSPECIFIED (e.g. a never-crawled URL's fetch state); report those as null. */
const known = (v?: string) => (v && !v.endsWith("_UNSPECIFIED") ? v : null);

function inspectionRow(url: string, r: UrlInspection) {
  const s = r.indexStatusResult ?? {};
  const items = (r.richResultsResult?.detectedItems ?? []).flatMap((d) => (d.items ?? [{}]).map((it) => {
    const issues = it.issues ?? [];
    return { type: d.richResultType, severity: issues.some((x) => x.severity === "ERROR") ? "ERROR" : issues.length ? "WARNING" : "VALID",
      issues: issues.map((x) => x.issueMessage) };
  }));
  return {
    url, indexed: s.verdict === "PASS", coverage_state: s.coverageState ?? null, last_crawl: s.lastCrawlTime ?? null,
    robots_txt: known(s.robotsTxtState), indexing_allowed: known(s.indexingState), fetch: known(s.pageFetchState),
    google_canonical: s.googleCanonical ?? null, declared_canonical: s.userCanonical ?? null,
    ...(s.googleCanonical && s.userCanonical && s.googleCanonical !== s.userCanonical ? { canonical_mismatch: true } : {}),
    crawled_as: known(s.crawledAs), ...(s.sitemap?.length ? { in_sitemaps: s.sitemap } : {}),
    ...(s.referringUrls?.length ? { referring_urls: s.referringUrls.slice(0, 5) } : {}),
    structured_data: r.richResultsResult ? { verdict: r.richResultsResult.verdict ?? null, items } : null,
  };
}

const organicMetrics = (r: SearchAnalyticsRow) => ({
  clicks: r.clicks, impressions: r.impressions, ctr_pct: round(r.ctr * 100), position: Math.round(r.position * 10) / 10,
});

export function dateRange(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const end = new Date(Date.now() - 86_400_000);           // yesterday: today is partial
  const start = new Date(end.getTime() - (d - 1) * 86_400_000);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`;
}

/** Sum rows' cost, clicks and conversions per key (Google returns one row per segment); `add` sums any extra metrics. */
/** Two decimals, for money and fractional conversions. */
const round = (n: number) => Math.round(n * 100) / 100;

function aggregate<T extends { cost: number; clicks: number; conversions: number }>(
  rows: any[], key: (r: any) => string, init: (r: any) => T, add?: (e: T, r: any) => void,
): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const e = m.get(k) ?? init(r);
    e.cost += micros(r.metrics?.costMicros);
    e.clicks += Number(r.metrics?.clicks ?? 0);
    e.conversions += Number(r.metrics?.conversions ?? 0);
    add?.(e, r);
    m.set(k, e);
  }
  return [...m.values()];
}
