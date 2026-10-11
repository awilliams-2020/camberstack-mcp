import express, { type Express } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { now, openDb, sweep, type DB } from "./db.js";
import { deriveKey } from "./crypto.js";
import { CamberstackProvider, MCP_SCOPE, consentCookie } from "./provider.js";
import { UserSession, type SessionDeps } from "./session.js";
import { Relay } from "./relay.js";
import { buildServer, SERVER_VERSION, toolCatalog } from "./tools.js";
import { Analytics, BEACON_JS, parseBeacon } from "./analytics.js";
import { mountAdmin } from "./admin.js";
import { mountAccount } from "./account.js";
import { Billing } from "./billing.js";
import { AdConversions } from "./adconversions.js";
import { Lifecycle, lifecycleSigningKey } from "./lifecycle.js";
import { errorPage, infoPage, homePage, chatgptGuidePage, claudeGuidePage, geminiGuidePage, llmsTxt, privacyPage, robotsTxt, SITEMAP_PATHS, sitemapXml, termsPage, toolsPage } from "./pages.js";
import { indexNowKey, pageDates, pingIndexNow } from "./lastmod.js";
import { readCookie } from "./http.js";

/** brand/ sits beside src/ and dist/ at the package root. */
const BRAND_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "brand");
const RESOURCE_NAME = "Camberstack Google Ads";
/** Gemini's OAuth relay; it registers its /r/ and /a/ paths on all three hosts. */
const GEMINI_REDIRECT = /^https:\/\/oauth-redirect(-sandbox|-test)?\.googleusercontent\.com\//;
const HOUR = 3600_000;

export interface Overrides extends Partial<SessionDeps> {
  fetch?: typeof fetch;
  analyticsFetch?: typeof fetch;
  stripeFetch?: typeof fetch;
  adsConversionFetch?: typeof fetch;
  mailFetch?: typeof fetch;
  indexNowFetch?: typeof fetch;
}

export interface Service {
  app: Express;
  billing: Billing;
  /** The background sweeps. Not started by createApp, so tests run without timers. */
  startJobs(): void;
  /** The conversion relay, so tests can flush it. */
  relay: Relay;
}

export function createApp(cfg: Config, db: DB, overrides: Overrides = {}): Service {
  const app = express();
  app.set("trust proxy", 1); // behind Traefik: one hop
  app.disable("x-powered-by");
  const adConversions = new AdConversions(db, cfg.conversions, cfg.baseUrl.startsWith("https://"), overrides.adsConversionFetch);
  const billing = new Billing({ db, baseUrl: cfg.baseUrl, stripe: cfg.stripe, fetch: overrides.stripeFetch,
    signingKey: deriveKey(cfg.encryptionKey, "billing-links") });
  const internalEmails = new Set([...cfg.adminEmails, ...cfg.proEmails]);
  const lifecycle = new Lifecycle({
    db, baseUrl: cfg.baseUrl, mail: cfg.mail, fetch: overrides.mailFetch, internalEmails,
    signingKey: lifecycleSigningKey(cfg.encryptionKey),
    upgradeLink: (userId) => billing.link("upgrade", userId),
  });
  const info = (title: string, body: string) => infoPage(cfg.baseUrl, title, body);

  const provider = new CamberstackProvider(db, {
    baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey, fetch: overrides.fetch,
  });
  const deps: SessionDeps = {
    db, baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey,
    freeAccounts: cfg.freeAccounts, proAccounts: cfg.proAccounts, proEmails: cfg.proEmails,
    billingLink: (kind, userId) => billing.link(kind, userId), refreshPlan: (userId) => billing.refreshPlan(userId), ...overrides,
  };
  const relay = new Relay(deps);
  const mcpUrl = new URL(`${cfg.baseUrl}/mcp`);
  const logCall = db.prepare(`INSERT INTO tool_calls (at, user_id, client_id, tool, customer_id, ok, error, ms, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const analytics = new Analytics({ matomoUrl: cfg.matomo?.url ?? "", siteId: cfg.matomo?.siteId ?? "",
    token: cfg.matomo?.token ?? "", site: cfg.baseUrl, fetch: overrides.analyticsFetch });

  app.use((req, res, next) => {
    analytics.aiFetch(req, res);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Before every public route: the admin host serves only the admin site.
  const admin = mountAdmin(app, {
    db, google: cfg.google, baseUrl: cfg.baseUrl, adminUrl: cfg.adminUrl, adminEmails: cfg.adminEmails,
    internalEmails, fetch: overrides.fetch,
  });

  // Gemini (Spark custom apps) registers asking for client_secret_post, takes the secret, then its
  // redirect page fails ("Cannot Complete Request") without ever calling /token. Registered as a public
  // client (PKCE only, no secret) it completes, as in ghchinoy/spark-agent-tools' field notes. Only
  // clients whose every redirect is Google's relay get this; everyone else keeps the SDK default.
  app.post("/register", express.json({ limit: "100kb" }), (req, _res, next) => {
    const uris = (req.body as { redirect_uris?: unknown })?.redirect_uris;
    if (Array.isArray(uris) && uris.length > 0
      && uris.every((u) => typeof u === "string" && GEMINI_REDIRECT.test(u))) {
      req.body.token_endpoint_auth_method = "none";
    }
    next();
  });

  // Issuer without the trailing slash the SDK always adds ("https://camberstack.io/"): for a bare origin
  // RFC 8414 derives the metadata URL from "https://camberstack.io", and Gemini abandoned the flow after
  // /register with the slashed form. Served ahead of the SDK router; every other field is the SDK's.
  const issuer = new URL(cfg.baseUrl).origin;
  const resourceMetadata = {
    resource: mcpUrl.href, authorization_servers: [issuer], scopes_supported: [MCP_SCOPE],
    resource_name: RESOURCE_NAME, resource_documentation: `${cfg.baseUrl}/#setup`,
  };
  app.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (_q, r) => {
    r.set("Access-Control-Allow-Origin", "*").json(resourceMetadata);
  });
  app.get("/.well-known/oauth-authorization-server", (_q, r) => {
    r.set("Access-Control-Allow-Origin", "*").json({
      issuer, service_documentation: `${cfg.baseUrl}/#setup`,
      authorization_endpoint: `${issuer}/authorize`, response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint: `${issuer}/token`, token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: [MCP_SCOPE],
      revocation_endpoint: `${issuer}/revoke`, revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      registration_endpoint: `${issuer}/register`,
    });
  });

  // OAuth: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(cfg.baseUrl),
    resourceServerUrl: mcpUrl,
    scopesSupported: [MCP_SCOPE],
    resourceName: RESOURCE_NAME,
    serviceDocumentationUrl: new URL(`${cfg.baseUrl}/#setup`),
  }));

  if (cfg.glamaClaim) {
    app.get("/.well-known/glama.json", (_q, r) => {
      r.json({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: cfg.glamaClaim });
    });
  }
  // The GEO audit that used to live on this domain. Gone for good, so say so instead of a plain 404.
  for (const p of ["/geo-audit", "/aeo-audit", "/ai-visibility-audit", "/ai-visibility-checker", "/methodology", "/report/:id", "/fixpack/:id"]) {
    app.get(p, (_q, r) => { r.status(410).type("html").send(errorPage(cfg.baseUrl, "That page belonged to an earlier product and has been removed.")); });
  }

  const account = mountAccount(app, {
    db, google: cfg.google, baseUrl: cfg.baseUrl, fetch: overrides.fetch,
    session: (userId) => UserSession.load(deps, userId), billingLink: (kind, userId) => billing.link(kind, userId),
  });

  // The consent page's answer (provider.authorize renders it). Same-origin form POST; the cookie the page set
  // is what proves this browser saw it, so a cross-site auto-submit or a forwarded link gets nowhere.
  app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : undefined;
    try {
      const to = provider.consent(id, req.body?.decision === "approve", id ? readCookie(req, consentCookie(id)) : undefined);
      res.redirect(303, to);
    } catch (e) {
      res.status(400).type("html").send(errorPage(cfg.baseUrl, (e as Error).message));
    }
  });

  app.get("/oauth/google/callback", async (req, res) => {
    // One registered redirect URI serves every Google flow. Web sign-ins (/admin, /account) are told
    // apart by their state prefix and finish on their own path, where their session cookie is scoped.
    const site = [admin, account].find((s) => s?.owns(req.query.state));
    if (site) {
      res.redirect(302, `${site.callbackUrl}?${new URLSearchParams(req.query as Record<string, string>)}`);
      return;
    }
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    try {
      const done = await provider.completeGoogleCallback({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      }, state ? readCookie(req, consentCookie(state)) : undefined);
      res.append("Set-Cookie", `${consentCookie(state!)}=; Path=/oauth/; Max-Age=0; SameSite=Lax${cfg.baseUrl.startsWith("https://") ? "; Secure" : ""}`);
      if (done.userId) {
        analytics.event(req, "connect");
        adConversions.record(req, res, done.userId, !!done.created);
      }
      res.redirect(302, done.to);
    } catch (e) {
      res.status(400).type("html").send(errorPage(cfg.baseUrl, (e as Error).message));
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // A fresh server per request, bound to the caller the bearer middleware verified.
  const serverFor = (auth: AuthInfo | undefined) => {
    const userId = String(auth?.extra?.userId ?? "");
    const clientId = auth?.clientId ?? null;
    let session: UserSession | undefined;
    return buildServer(() => (session ??= UserSession.load(deps, userId)), (c) => {
      logCall.run(now(), userId, clientId, c.tool, c.customerId, c.ok ? 1 : 0, c.error, c.ms, c.bytes);
    });
  };
  // 2026-07-28 traffic (server/discover, per-request _meta envelope). The SDK's own legacy leg would
  // answer 2025-era requests over SSE, so it is off and those keep the JSON-response wiring below.
  // The OAuth server (mcpAuthRouter, requireBearerAuth) stays on SDK 1.x: v2 ships no authorization server.
  const modern = toNodeHandler(createMcpHandler((ctx) => serverFor(ctx.authInfo as AuthInfo | undefined), {
    legacy: "reject",
    onerror: (e) => console.warn(`mcp error: ${e.message}`),
  }));

  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    res.on("finish", () => {
      // Diagnostics for rejected requests only: method + protocol header, never arguments or data.
      if (res.statusCode >= 400) {
        const body = req.body as { method?: string } | { method?: string }[] | undefined;
        const method = Array.isArray(body) ? `batch[${body.map((b) => b?.method).join(",")}]` : body?.method;
        console.warn(`mcp ${res.statusCode} method=${method ?? "?"} protocol=${req.get("mcp-protocol-version") ?? "-"} accept=${req.get("accept") ?? "-"} ua=${req.get("user-agent") ?? "-"}`);
      }
    });
    try {
      if (!(await isLegacyRequest(await toWebRequest(req, req.body), req.body))) return await modern(req, res, req.body);
      // 2025-era: stateless, one JSON body per request, as before v2.
      const server = serverFor(req.auth);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  const noSessions = (_req: express.Request, res: express.Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null });
  };
  app.get("/mcp", noSessions);
  app.delete("/mcp", noSessions);

  const page = (html: string) => (req: express.Request, res: express.Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    adConversions.captureClick(req, res);  // keeps an ad click id; makes the response private if it does
    res.type("html").send(html);
  };
  const tools = toolCatalog();
  const pages: Record<string, string> = {
    "/": homePage(cfg.baseUrl),
    "/google-ads-claude": claudeGuidePage(cfg.baseUrl),
    "/google-ads-chatgpt": chatgptGuidePage(cfg.baseUrl),
    "/tools": toolsPage(cfg.baseUrl, tools),
    "/privacy": privacyPage(cfg.baseUrl),
    "/terms": termsPage(cfg.baseUrl),
  };
  for (const [path, html] of Object.entries(pages)) app.get(path, page(html));
  app.get("/google-ads-gemini", page(geminiGuidePage(cfg.baseUrl)));
  const indexed = Object.fromEntries(SITEMAP_PATHS.map((p) => [p, pages[p]!]));
  const { dates: lastmod, changed: changedPages } = pageDates(db, indexed, cfg.gitCommitDate);
  const inKey = indexNowKey(cfg.encryptionKey);
  app.get(`/${inKey}.txt`, (_q, r) => { r.type("text/plain").send(inKey); });
  app.get("/robots.txt", (_q, r) => { r.type("text/plain").send(robotsTxt(cfg.baseUrl)); });
  app.get("/llms.txt", (_q, r) => { r.type("text/plain").send(llmsTxt(cfg.baseUrl, tools)); });
  app.get("/sitemap.xml", (_q, r) => { r.type("application/xml").send(sitemapXml(cfg.baseUrl, lastmod)); });
  // Brand assets: the SVG is the source; the PNGs are rendered from it (brand/).
  const brand = (file: string, type: string) => (_q: express.Request, r: express.Response) => {
    r.setHeader("Cache-Control", "public, max-age=86400");
    r.type(type).sendFile(file, { root: BRAND_DIR });
  };
  app.get("/favicon.svg", brand("logo.svg", "image/svg+xml"));
  app.get("/favicon.png", brand("favicon-32.png", "image/png"));
  app.get("/favicon.ico", brand("favicon-32.png", "image/png"));
  app.get("/logo.png", brand("logo-wordmark-480.png", "image/png"));
  // Self-hosted IBM Plex (OFL, brand/fonts/OFL.txt), so pages make no third-party font requests.
  app.get("/fonts/:file", (q, r, next) => {
    if (!/^[a-z0-9-]+\.woff2$/.test(q.params.file)) return next();
    brand(`fonts/${q.params.file}`, "font/woff2")(q, r);
  });
  // Setup-guide screenshots (brand/shots/): cropped, personal data painted out, WebP.
  app.get("/shots/:file", (q, r, next) => {
    if (!/^[a-z0-9-]+\.webp$/.test(q.params.file)) return next();
    brand(`shots/${q.params.file}`, "image/webp")(q, r);
  });
  billing.mount(app, info);
  lifecycle.mount(app, info);

  // Page-view beacon (analytics.ts): only browsers that run JS are counted, which keeps bots out.
  app.get("/e.js", (_q, r) => { r.setHeader("Cache-Control", "public, max-age=86400"); r.type("application/javascript").send(BEACON_JS); });
  // Conversion relay for the operator's own apps (relay.ts): key-authenticated, no cookies, no CORS.
  app.post("/v1/conversions", express.json({ limit: "10kb" }), relay.handle);

  app.post("/e", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const b = parseBeacon(req.body ?? {});
    if (b) analytics.pageview(req, b);
    res.status(204).end();
  });
  app.get("/healthz", (_q, r) => { r.json({ ok: true, version: SERVER_VERSION, sha: cfg.gitSha }); });

  app.use((_req, res) => { res.status(404).type("html").send(errorPage(cfg.baseUrl, "Page not found.")); });

  const every = (ms: number, name: string, job: () => unknown) => {
    const run = async () => { try { await job(); } catch (e) { console.error(`${name}: ${(e as Error).message}`); } };
    setInterval(run, ms).unref();
    return run;
  };
  const startJobs = () => {
    every(10 * 60_000, "db sweep", () => sweep(db));
    void every(HOUR, "billing sweep", () => billing.sweep())();  // also at boot: a restart mustn't delay a downgrade an hour
    every(HOUR, "lifecycle", () => lifecycle.run());
    every(HOUR, "ad conversions", () => adConversions.flush());
    every(HOUR, "relay conversions", () => relay.flush());
    // Pages new or changed since the last boot. Production only: a dev or test origin isn't ours to submit.
    if (cfg.baseUrl.startsWith("https://")) {
      pingIndexNow(cfg.baseUrl, inKey, changedPages, overrides.indexNowFetch)
        .then(() => changedPages.length && console.log(`IndexNow: submitted ${changedPages.join(" ")}`))
        .catch((e) => console.error(`IndexNow: ${(e as Error).message}`));
    }
  };
  return { app, billing, startJobs, relay };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cfg = loadConfig();
  const { app, startJobs } = createApp(cfg, openDb(cfg.dataDir));
  startJobs();
  app.listen(cfg.port, () => console.log(`camberstack-mcp ${SERVER_VERSION} on :${cfg.port} (${cfg.baseUrl})`));
}
