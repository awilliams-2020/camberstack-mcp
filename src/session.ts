/**
 * Everything one connected user can do, independent of MCP. The MCP tools in tools.ts are thin
 * wrappers over these methods, which keeps them testable with a fake Ads client.
 */
import { randomUUID } from "node:crypto";
import type { DB, ProposalRow, UserRow } from "./db.js";
import { now } from "./db.js";
import { decrypt } from "./crypto.js";
import { AdsClient, refreshGoogleToken, revokeGoogleToken, type GoogleCreds } from "./google.js";
import { analyzeWaste, round, type CampaignRow, type ConversionActionRow, type KeywordRow, type SearchTermRow } from "./analysis.js";
import {
  ChangeSchema, MAX_CHANGES, PROPOSAL_TTL, inverseAfterApply, resolveChange, summarize,
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
  google: GoogleCreds;
  encryptionKey: Buffer;
  freeApplies: number;
  proEmails: Set<string>;
  /** Signed per-user billing links (billing.ts); null when billing isn't configured. */
  billingLink?: (kind: "upgrade" | "billing", userId: string) => string | null;
  /** Tests inject a fake. */
  adsFactory?: (user: UserRow) => AdsClient;
}

export class NotConnectedError extends Error {}

export class UserSession {
  readonly ads: AdsClient;
  private accountsCache?: { at: number; list: Account[] };
  /** Accounts the login can see but Google refused to read, from the last accounts() call. */
  lastUnreadable: { customerId: string; error: string }[] = [];

  constructor(private deps: SessionDeps, readonly user: UserRow) {
    this.ads = deps.adsFactory?.(user) ?? new AdsClient(() => this.googleAccessToken(), deps.google.developerToken);
  }

  static load(deps: SessionDeps, userId: string): UserSession {
    const user = deps.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!user) throw new NotConnectedError("Unknown user; connect Camberstack again.");
    deps.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), userId);
    return new UserSession(deps, user);
  }

  private async googleAccessToken(): Promise<string> {
    const hit = tokenCache.get(this.user.id);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    if (!this.user.enc_refresh) throw new NotConnectedError("Google Ads is disconnected. Reconnect Camberstack in your AI app.");
    try {
      const t = await refreshGoogleToken(this.deps.google, decrypt(this.deps.encryptionKey, this.user.enc_refresh));
      tokenCache.set(this.user.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
      return t.access_token;
    } catch (e) {
      if ((e as { revoked?: boolean }).revoked) {
        this.deps.db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = ?").run(this.user.id);
        throw new NotConnectedError("Google access was revoked. Reconnect Camberstack in your AI app.");
      }
      throw e;
    }
  }

  get isPro(): boolean {
    return this.user.plan === "pro" || this.deps.proEmails.has(this.user.email.toLowerCase());
  }

  /** Free applies left; null for Pro (unlimited). Undo proposals never count. */
  freeAppliesLeft(): number | null {
    if (this.isPro) return null;
    const used = (this.deps.db.prepare("SELECT count(*) n FROM proposals WHERE user_id = ? AND status = 'applied' AND undo_of IS NULL")
      .get(this.user.id) as { n: number }).n;
    return Math.max(0, this.deps.freeApplies - used);
  }

  plan() {
    const left = this.freeAppliesLeft();
    const upgrade = this.deps.billingLink?.("upgrade", this.user.id) ?? null;
    const account_page = "https://camberstack.io/account";
    return this.isPro
      ? { plan: "pro", account_page, applies: "unlimited",
          // Pro without a Stripe customer is complimentary (PRO_EMAILS): nothing to manage or cancel.
          ...(this.user.stripe_customer
            ? { manage_billing: this.deps.billingLink?.("billing", this.user.id) ?? null }
            : { complimentary: true, manage_billing: null }) }
      : { plan: "free", account_page, free_applies_left: left, free_applies_total: this.deps.freeApplies,
          always_free: "diagnosis, proposals, change history and undo",
          pro: "unlimited applied changes, $49/month, cancel any time", upgrade_url: upgrade,
          note: upgrade ? "Show the user upgrade_url as a link; it is personal and expires in 7 days." : "Upgrades are not open yet." };
  }

  // ---------------------------------------------------------------- read

  async accounts(): Promise<Account[]> {
    if (this.accountsCache && Date.now() - this.accountsCache.at < 10 * 60_000) return this.accountsCache.list;
    const roots = await this.ads.listAccessibleCustomers();
    const out = new Map<string, Account>();
    const unreadable: { customerId: string; error: string }[] = [];
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
    if (!list.length && unreadable.length) {
      throw new Error(`This login can see ${unreadable.length} Google Ads account(s) but none could be read. ${unreadable[0]!.error}`);
    }
    this.lastUnreadable = unreadable;
    this.accountsCache = { at: Date.now(), list };
    return list;
  }

  async account(customerId: string): Promise<Account> {
    const cid = customerId.replace(/-/g, "");
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
    const byId = new Map<string, any>();
    for (const r of rows) {
      const id = String(r.campaign.id);
      const e = byId.get(id) ?? {
        campaign_id: id, name: r.campaign.name, status: r.campaign.status, type: r.campaign.advertisingChannelType,
        bidding: r.campaign.biddingStrategyType, daily_budget: micros(r.campaignBudget?.amountMicros),
        cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0,
      };
      e.cost += micros(r.metrics.costMicros); e.clicks += Number(r.metrics.clicks ?? 0);
      e.impressions += Number(r.metrics.impressions ?? 0); e.conversions += Number(r.metrics.conversions ?? 0);
      e.conversion_value += Number(r.metrics.conversionsValue ?? 0);
      byId.set(id, e);
    }
    const campaigns = [...byId.values()].map((c) => ({
      ...c, cost: round(c.cost), conversions: round(c.conversions),
      cost_per_conversion: c.conversions > 0 ? round(c.cost / c.conversions) : null,
    })).sort((x, y) => y.cost - x.cost);
    const cost = campaigns.reduce((s, c) => s + c.cost, 0);
    const conv = campaigns.reduce((s, c) => s + c.conversions, 0);
    return {
      account: { customer_id: a.customerId, name: a.name, currency: a.currency },
      window: `last ${days} days`,
      totals: { cost: round(cost), conversions: round(conv), cost_per_conversion: conv > 0 ? round(cost / conv) : null },
      campaigns,
    };
  }

  async wastedSpend(customerId: string, days: number, campaignId?: string) {
    const a = await this.account(customerId);
    const scope = campaignId ? ` AND campaign.id = ${Number(campaignId)}` : "";
    const [campaignRows, termRows, kwRows, actionRows, negRows] = await Promise.all([
      this.ads.search(a.customerId, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM campaign WHERE ${dateRange(days)} AND campaign.status != 'REMOVED'${scope}`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT search_term_view.search_term, campaign.id, campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM search_term_view WHERE ${dateRange(days)}${scope}`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
          ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
          ad_group_criterion.status, metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM keyword_view WHERE ${dateRange(days)}${scope}`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT conversion_action.id, conversion_action.name, conversion_action.category,
          conversion_action.status, conversion_action.primary_for_goal, conversion_action.type
        FROM conversion_action WHERE conversion_action.status != 'REMOVED'`, a.loginCustomerId),
      this.ads.search(a.customerId, `SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = true${scope}`,
        a.loginCustomerId),
    ]);
    const terms = aggregate<SearchTermRow>(termRows, (r) => `${r.campaign.id}|${r.searchTermView.searchTerm}`, (r) => ({
      term: r.searchTermView.searchTerm, campaignId: String(r.campaign.id), campaignName: r.campaign.name,
      cost: 0, clicks: 0, conversions: 0,
    }));
    const keywords = aggregate<KeywordRow>(kwRows, (r) => `${r.adGroup.id}~${r.adGroupCriterion.criterionId}`, (r) => ({
      campaignId: String(r.campaign.id), campaignName: r.campaign.name, adGroupId: String(r.adGroup.id),
      adGroupName: r.adGroup.name, criterionId: String(r.adGroupCriterion.criterionId),
      text: r.adGroupCriterion.keyword?.text ?? "", matchType: r.adGroupCriterion.keyword?.matchType ?? "",
      status: r.adGroupCriterion.status, cost: 0, clicks: 0, conversions: 0,
    }));
    const campaigns = aggregate<CampaignRow>(campaignRows, (r) => String(r.campaign.id), (r) => ({
      campaignId: String(r.campaign.id), name: r.campaign.name, type: r.campaign.advertisingChannelType,
      status: r.campaign.status, cost: 0, clicks: 0, conversions: 0,
    }));
    const actions: ConversionActionRow[] = actionRows.map((r) => ({
      id: String(r.conversionAction.id), name: r.conversionAction.name, category: r.conversionAction.category,
      status: r.conversionAction.status, primaryForGoal: !!r.conversionAction.primaryForGoal, type: r.conversionAction.type,
    }));
    const existingNegatives = new Set(negRows.map((r) =>
      `${r.campaign.id}|${String(r.campaignCriterion.keyword?.text ?? "").toLowerCase()}|${r.campaignCriterion.keyword?.matchType}`));
    const report = analyzeWaste({ window: `last ${days} days`, currency: a.currency, terms, keywords, campaigns, actions, existingNegatives });
    return { account: { customer_id: a.customerId, name: a.name, currency: a.currency }, ...report };
  }

  async runQuery(customerId: string, query: string) {
    if (!/^\s*select\b/i.test(query)) throw new Error("Only SELECT (read-only GAQL) queries are allowed. Use propose_changes to change anything.");
    const a = await this.account(customerId);
    const rows = await this.ads.search(a.customerId, query, a.loginCustomerId);
    return { rows: rows.slice(0, 500), truncated: rows.length > 500, total_rows: rows.length };
  }

  // ---------------------------------------------------------------- write

  async propose(customerId: string, rawChanges: unknown[], undoOf?: string): Promise<{ proposal_id: string; summary: string; changes: number; skipped: string[] }> {
    const a = await this.account(customerId);
    const changes: Change[] = rawChanges.map((c) => ChangeSchema.parse(c));
    const count = changes.reduce((n, c) => n + (c.type === "add_negative_keywords" ? c.keywords.length : 1), 0);
    if (count > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes per proposal (got ${count}). Split it.`);
    const resolved: ResolvedChange[] = [];
    for (const c of changes) resolved.push(await resolveChange(this.ads, a.customerId, a.loginCustomerId, c));
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
    // Undo is always free: a paywall must never stand between a user and reversing a change.
    const left = p.undo_of ? null : this.freeAppliesLeft();
    if (left === 0) {
      const url = this.deps.billingLink?.("upgrade", this.user.id);
      throw new Error(`This account has used its ${this.deps.freeApplies} free applied changes. Camberstack Pro ($49/month, cancel any time) applies changes without limit. `
        + (url ? `Show the user this personal upgrade link: ${url} — then apply proposal ${p.id} again once they have paid (it stays open for 24 hours). ` : "Upgrades open soon; see https://camberstack.io/#pricing. ")
        + "Diagnosis, proposals, change history and undo stay free.");
    }
    if (p.status !== "proposed") throw new Error(`Proposal ${proposalId} is already ${p.status}.`);
    if (p.created_at < now() - PROPOSAL_TTL) throw new Error(`Proposal ${proposalId} is older than 24 hours; the account may have changed. Propose again.`);
    const changes = JSON.parse(p.changes) as Change[];
    const outcomes: { describe: string; ok: boolean; error?: string; inverse?: Change }[] = [];
    for (const c of changes) {
      let describe = c.type as string;
      try {
        // Re-resolve: the account may have moved since the proposal was made.
        const r = await resolveChange(this.ads, p.customer_id, p.login_customer_id, c);
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
      results: outcomes.map(({ describe, ok, error }) => ({ change: describe, ok, ...(error ? { error } : {}) })),
      undo: anyOk ? `To reverse this, call undo_changes with proposal_id "${p.id}".` : undefined,
      ...(left !== null && anyOk ? { free_applies_left: left - 1 } : {}),
      // The moment the last free apply is used is when Pro is easiest to explain: say it once, not as a wall.
      ...(left === 1 && anyOk ? {
        upgrade_url: this.deps.billingLink?.("upgrade", this.user.id) ?? null,
        note: "That was the last of the 3 free applied changes. Mention once, briefly, that Camberstack Pro ($49/month, cancel any time) applies changes without limit, and show upgrade_url as a link if present. Diagnosis, proposals and undo stay free.",
      } : {}),
    };
  }

  async undo(proposalId: string) {
    const p = this.proposal(proposalId);
    if (p.status !== "applied") throw new Error(`Only applied proposals can be undone (${proposalId} is ${p.status}).`);
    const outcomes = JSON.parse(p.result ?? "[]") as { inverse?: Change }[];
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
        .all(this.user.id, customerId.replace(/-/g, ""), limit)
      : this.deps.db.prepare("SELECT * FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(this.user.id, limit)) as ProposalRow[];
    return rows.map((p) => ({
      proposal_id: p.id, customer_id: p.customer_id, status: p.status, summary: p.summary,
      proposed_at: new Date(p.created_at * 1000).toISOString(),
      applied_at: p.applied_at ? new Date(p.applied_at * 1000).toISOString() : null,
      undo_of: p.undo_of,
      results: p.result ? (JSON.parse(p.result) as { describe: string; ok: boolean; error?: string }[])
        .map(({ describe, ok, error }) => ({ change: describe, ok, ...(error ? { error } : {}) })) : undefined,
    }));
  }

  private proposal(id: string): ProposalRow {
    const p = this.deps.db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(id, this.user.id) as ProposalRow | undefined;
    if (!p) throw new Error(`No proposal ${id} for this user.`);
    return p;
  }

  /** Revoke at Google, forget the refresh token and every token we issued. Change history is kept. */
  async disconnect() {
    if (this.user.enc_refresh) await revokeGoogleToken(decrypt(this.deps.encryptionKey, this.user.enc_refresh));
    this.deps.db.prepare("UPDATE users SET enc_refresh = NULL WHERE id = ?").run(this.user.id);
    this.deps.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(this.user.id);
    tokenCache.delete(this.user.id);
    return { disconnected: true, note: "Google access revoked and stored credentials deleted. To delete your change history too, email adam@camberstack.io." };
  }
}

export function dateRange(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const end = new Date(Date.now() - 86_400_000);           // yesterday: today is partial
  const start = new Date(end.getTime() - (d - 1) * 86_400_000);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`;
}

const micros = (m: unknown) => Number(m ?? 0) / 1_000_000;

function aggregate<T extends { cost: number; clicks: number; conversions: number }>(
  rows: any[], key: (r: any) => string, init: (r: any) => T,
): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const e = m.get(k) ?? init(r);
    e.cost += micros(r.metrics?.costMicros);
    e.clicks += Number(r.metrics?.clicks ?? 0);
    e.conversions += Number(r.metrics?.conversions ?? 0);
    m.set(k, e);
  }
  return [...m.values()];
}
