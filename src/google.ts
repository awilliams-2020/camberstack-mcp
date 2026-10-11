/**
 * Google OAuth (the user's consent to Google Ads access) and a thin Google Ads REST client.
 *
 * Scopes requested: `adwords` (the Ads API, required), `webmasters.readonly` (Search Console, read-only and
 * optional: the user can untick it and the Ads tools still work) and `openid email` (to know who the user
 * is, so a reconnect finds the same account and change log). Nothing else from the Google account is touched.
 */

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GOOGLE_SCOPES = ["openid", "email", ADS_SCOPE, SEARCH_CONSOLE_SCOPE];
export const ADS_API = "https://googleads.googleapis.com/v23";

/** The Ads API counts money in millionths of the account currency. */
export const micros = (m: unknown) => Number(m ?? 0) / 1_000_000;
export const toMicros = (x: number) => String(Math.round(x * 1_000_000));

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  developerToken?: string;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

export function googleAuthUrl(creds: GoogleCreds, redirectUri: string, state: string): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Always show consent so Google always returns a refresh token, including on reconnect.
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  })}`;
}

/** Identity only (openid email), no Ads access and no refresh token: the operator's /admin sign-in. */
export function googleSignInUrl(creds: GoogleCreds, redirectUri: string, state: string): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: creds.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "openid email", prompt: "select_account", state,
  })}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

type FetchLike = typeof fetch;

const postForm = (f: FetchLike, url: string, form: Record<string, string>) =>
  f(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

export async function exchangeGoogleCode(
  creds: GoogleCreds, code: string, redirectUri: string, f: FetchLike = fetch,
): Promise<GoogleTokenResponse> {
  const res = await postForm(f, GOOGLE_TOKEN, {
    code, client_id: creds.clientId, client_secret: creds.clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshGoogleToken(
  creds: Pick<GoogleCreds, "clientId" | "clientSecret">, refreshToken: string, f: FetchLike = fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await postForm(f, GOOGLE_TOKEN, {
    refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret,
    grant_type: "refresh_token",
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Google token refresh failed: ${res.status} ${body}`);
    if (body.includes("invalid_grant")) (err as Error & { revoked?: boolean }).revoked = true;
    throw err;
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

export async function revokeGoogleToken(token: string, f: FetchLike = fetch): Promise<void> {
  await postForm(f, "https://oauth2.googleapis.com/revoke", { token }).catch(() => undefined);
}

/**
 * The id_token arrives directly from Google's token endpoint over TLS, in exchange for a code plus our
 * client secret, so its claims can be read without verifying the signature (OpenID Connect Core
 * §3.1.3.7, item 6).
 */
export function idTokenClaims(idToken: string): { sub: string; email: string; emailVerified: boolean } {
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!payload.sub || !payload.email) throw new Error("id_token missing sub/email");
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), emailVerified: payload.email_verified === true };
}

const DURING_LITERALS = "TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH, LAST_BUSINESS_WEEK, "
  + "THIS_WEEK_MON_TODAY, THIS_WEEK_SUN_TODAY, LAST_WEEK_MON_SUN, LAST_WEEK_SUN_SAT";

/**
 * How to fix the GAQL and request errors AIs actually hit (tool_calls.error), appended to Google's message.
 * The rules are in run_gaql's description too, but a fix next to the error gets the retry right first time.
 */
export function adsErrorFix(code: string, message: string, field: string): string | null {
  switch (code) {
    case "EXPECTED_FILTERS_ON_DATE_RANGE":
      return "add a finite range to WHERE: segments.date DURING LAST_30_DAYS, or segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.";
    case "EXPECTED_FILTER_ON_A_SINGLE_DAY":
      return "click_view needs one day: segments.date = 'YYYY-MM-DD'. Query each day separately.";
    case "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE":
      return "add that field to SELECT. Every field used in WHERE or ORDER BY must also be selected.";
    case "INVALID_VALUE_WITH_DURING_OPERATOR":
      return `DURING accepts only ${DURING_LITERALS}. For any other window use segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.`;
    case "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE":
      return /impression_share/.test(message)
        ? "budget- and rank-lost impression share exist only on campaign: run a separate query FROM campaign for them."
        : "that metric isn't available on this FROM resource or with these segments: drop it, or get it in a separate query.";
    case "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE":
    case "PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE":
      return "that resource or segment can't be combined with this FROM: query it directly, in its own query.";
    case "UNRECOGNIZED_FIELD":
      return /campaign\.(start|end)_date'/.test(message)
        ? "campaign dates are campaign.start_date_time and campaign.end_date_time."
        : "check the name: fields are prefixed with their resource (campaign.name, ad_group.status, metrics.clicks).";
    case "BAD_FIELD_NAME":
      return /'\('/.test(message)
        ? "GAQL has no parentheses or OR: WHERE conditions can only be joined with AND. Use field IN ('a', 'b') for alternatives, or separate queries."
        : null;
    case "INVALID_VALUE":
      return field === "geo_target_constants"
        ? "a location ID isn't a valid geo target. Look it up with run_gaql: SELECT geo_target_constant.id, geo_target_constant.canonical_name "
          + "FROM geo_target_constant WHERE geo_target_constant.name = 'Thailand'"
        : null;
    default:
      return null;
  }
}

export class AdsApiError extends Error {
  constructor(public status: number, public body: string) {
    super(AdsApiError.summarize(status, body));
  }
  /** Google's error bodies are deep; surface the part a human (or an AI) can act on. */
  static summarize(status: number, body: string): string {
    try {
      const j = JSON.parse(body);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      const details = e?.details?.flatMap((d: any) => d.errors ?? []) ?? [];
      const msgs = details.map((d: any) => {
        const code = d.errorCode ? Object.values(d.errorCode)[0] : "";
        const field = d.location?.fieldPathElements?.map((p: any) => p.fieldName).join(".");
        const fix = adsErrorFix(String(code), String(d.message ?? ""), field ?? "");
        return [code, d.message, field ? `(field ${field})` : "", fix ? `→ ${fix}` : ""].filter(Boolean).join(" ");
      });
      return `Google Ads API ${status}: ${msgs.length ? msgs.join("; ") : e?.message ?? body.slice(0, 300)}`;
    } catch {
      return `Google Ads API ${status}: ${body.slice(0, 300)}`;
    }
  }
}

/** One user's view of the Ads API. `accessToken` is a short-lived Google token. */
export class AdsClient {
  constructor(
    private accessToken: () => Promise<string>,
    private developerToken?: string,
    private f: FetchLike = fetch,
  ) {}

  private async headers(loginCustomerId?: string | null): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      ...(this.developerToken ? { "developer-token": this.developerToken } : {}),
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
    };
  }

  /** Response body as text; throws AdsApiError on a non-2xx. */
  private static async body(res: Response): Promise<string> {
    const body = await res.text();
    if (!res.ok) throw new AdsApiError(res.status, body);
    return body;
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const res = await this.f(`${ADS_API}/customers:listAccessibleCustomers`, { headers: await this.headers() });
    return ((JSON.parse(await AdsClient.body(res)).resourceNames ?? []) as string[]).map((r) => r.split("/")[1]!);
  }

  async search(customerId: string, query: string, loginCustomerId?: string | null): Promise<any[]> {
    const res = await this.f(`${ADS_API}/customers/${customerId}/googleAds:searchStream`, {
      method: "POST",
      headers: await this.headers(loginCustomerId),
      body: JSON.stringify({ query }),
    });
    return (JSON.parse(await AdsClient.body(res)) as { results?: any[] }[]).flatMap((b) => b.results ?? []);
  }

  /** Keyword Planner (KeywordPlanIdeaService). Read-only: needs Basic access or above on the developer token. */
  async keywordPlan(
    customerId: string, method: "generateKeywordIdeas" | "generateKeywordHistoricalMetrics", request: object, loginCustomerId?: string | null,
  ): Promise<{ results?: any[] }> {
    const res = await this.f(`${ADS_API}/customers/${customerId}:${method}`, {
      method: "POST",
      headers: await this.headers(loginCustomerId),
      body: JSON.stringify(request),
    });
    const body = await AdsClient.body(res);
    return body ? JSON.parse(body) : {};
  }

  /**
   * `service` is the REST collection, e.g. "campaignCriteria". Atomic unless partialFailure.
   * "googleAds" is the cross-service mutate: `operations` are MutateOperations (which may reference
   * each other by temporary negative ids), and its per-service results are flattened to the same
   * `{ resourceName }` shape, in order.
   */
  async mutate(
    customerId: string, service: string, operations: object[],
    opts: { validateOnly?: boolean; loginCustomerId?: string | null } = {},
  ): Promise<{ results: { resourceName?: string }[] }> {
    const cross = service === "googleAds";
    const res = await this.f(`${ADS_API}/customers/${customerId}/${service}:mutate`, {
      method: "POST",
      headers: await this.headers(opts.loginCustomerId),
      // campaignConversionGoals:mutate has no partialFailure field and 400s on it (it's atomic anyway).
      body: JSON.stringify({ [cross ? "mutateOperations" : "operations"]: operations, validateOnly: !!opts.validateOnly,
        ...(service === "campaignConversionGoals" ? {} : { partialFailure: false }) }),
    });
    const body = await AdsClient.body(res);
    const json = body ? JSON.parse(body) : {};
    if (!cross) return json.results ? json : { results: [] };
    return { results: (json.mutateOperationResponses ?? []).map((r: Record<string, { resourceName?: string }>) =>
      ({ resourceName: Object.values(r)[0]?.resourceName })) };
  }

  /**
   * Upload click conversions (partialFailure, so one stale click id doesn't sink the rest). Returns one
   * error string per conversion, null where it was accepted.
   */
  async uploadClickConversions(
    customerId: string, conversions: object[], loginCustomerId?: string | null,
  ): Promise<(string | null)[]> {
    const res = await this.f(`${ADS_API}/customers/${customerId}:uploadClickConversions`, {
      method: "POST",
      headers: await this.headers(loginCustomerId),
      body: JSON.stringify({ conversions, partialFailure: true }),
    });
    const body = await AdsClient.body(res);
    const json = body ? JSON.parse(body) : {};
    const errors = conversions.map((): string | null => null);
    for (const d of json.partialFailureError?.details ?? []) {
      for (const e of d.errors ?? []) {
        const i = e.location?.fieldPathElements?.find((x: { fieldName?: string }) => x.fieldName === "conversions")?.index ?? 0;
        errors[i] = String(e.message ?? "rejected").slice(0, 300);
      }
    }
    if (json.partialFailureError && !errors.some(Boolean)) errors.fill(String(json.partialFailureError.message ?? "rejected").slice(0, 300));
    return errors;
  }
}

const SEARCH_CONSOLE_API = "https://www.googleapis.com/webmasters/v3";
/** URL Inspection lives on the newer host; webmasters.readonly is enough for it. */
const URL_INSPECTION_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/** Raised when the user's Google connection doesn't include Search Console (unticked, or connected before it existed). */
export class SearchConsoleNotGrantedError extends Error {
  constructor() {
    super("Search Console access isn't part of this Google connection: it was unticked on Google's consent screen, or Camberstack "
      + "was connected before Search Console tools existed. To add it, the user reconnects Camberstack in their AI app and leaves "
      + "the Search Console box ticked. The Google Ads tools keep working either way.");
  }
}

export interface SearchAnalyticsRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit: number;
  startRow?: number;
  /** "all" includes the last 2-3 days Google is still filling in; omitted means final data only. */
  dataState?: "all" | "final";
  dimensionFilterGroups?: { filters: { dimension: string; operator: string; expression: string }[] }[];
}
export interface Sitemap {
  path: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; isSitemapsIndex?: boolean;
  warnings?: string; errors?: string; contents?: { type: string; submitted?: string }[];
}
/** The parts of urlInspection.index.inspect's `inspectionResult` the tools read. */
export interface UrlInspection {
  indexStatusResult?: {
    verdict?: string; coverageState?: string; lastCrawlTime?: string; robotsTxtState?: string; indexingState?: string;
    pageFetchState?: string; googleCanonical?: string; userCanonical?: string; crawledAs?: string; sitemap?: string[]; referringUrls?: string[];
  };
  richResultsResult?: { verdict?: string; detectedItems?: { richResultType: string; items?: { name?: string; issues?: { issueMessage: string; severity: string }[] }[] }[] };
}

/** One user's view of the Search Console API (read-only). */
export class SearchConsoleClient {
  constructor(private accessToken: () => Promise<string>, private f: FetchLike = fetch) {}

  private async get(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.f(path.startsWith("https://") ? path : `${SEARCH_CONSOLE_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
    });
    const body = await res.text();
    if (!res.ok) {
      if (res.status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(body)) throw new SearchConsoleNotGrantedError();
      let msg = body.slice(0, 300);
      try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* not JSON */ }
      // AIs guess sc-domain:example.com when the user's property is https://www.example.com/ (or the reverse).
      const fix = res.status === 403 && /permission/i.test(msg)
        ? " → use a property exactly as search_console_sites lists it: sc-domain:example.com and https://www.example.com/ are different properties." : "";
      throw new Error(`Search Console API ${res.status}: ${msg}${fix}`);
    }
    return body ? JSON.parse(body) : {};
  }

  async sites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    return (await this.get("/sites")).siteEntry ?? [];
  }

  async searchAnalytics(siteUrl: string, req: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    return (await this.get(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: "POST", body: JSON.stringify({ type: "web", ...req }) })).rows ?? [];
  }

  /** Sitemaps submitted for the property, with Google's last fetch and its error/warning counts. Read-only. */
  async sitemaps(siteUrl: string): Promise<Sitemap[]> {
    return (await this.get(`/sites/${encodeURIComponent(siteUrl)}/sitemaps`)).sitemap ?? [];
  }

  /** Google's index record for one URL in the property, as of its last crawl. */
  async inspect(siteUrl: string, url: string): Promise<UrlInspection> {
    return (await this.get(URL_INSPECTION_API, { method: "POST", body: JSON.stringify({ inspectionUrl: url, siteUrl }) })).inspectionResult ?? {};
  }
}
