import express, { type Express } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

/** brand/ sits beside src/ and dist/ at the package root. */
const BRAND_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "brand");
import { loadConfig, type Config } from "./config.js";
import { now, openDb, sweep, type DB } from "./db.js";
import { CamberstackProvider, MCP_SCOPE } from "./provider.js";
import { UserSession, type SessionDeps } from "./session.js";
import { buildServer, SERVER_VERSION } from "./tools.js";
import { Analytics, BEACON_JS, parseBeacon } from "./analytics.js";
import { errorPage, homePage, llmsTxt, privacyPage, robotsTxt, sitemapXml, termsPage } from "./pages.js";

export function createApp(cfg: Config, db: DB, overrides: Partial<SessionDeps> & { fetch?: typeof fetch; analyticsFetch?: typeof fetch } = {}): Express {
  const app = express();
  app.set("trust proxy", 1); // behind Traefik: one hop
  app.disable("x-powered-by");

  const provider = new CamberstackProvider(db, {
    baseUrl: cfg.baseUrl, google: cfg.google, encryptionKey: cfg.encryptionKey, fetch: overrides.fetch,
  });
  const deps: SessionDeps = {
    db, google: cfg.google, encryptionKey: cfg.encryptionKey,
    applyRequiresPro: cfg.applyRequiresPro, proEmails: cfg.proEmails, ...overrides,
  };
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

  // OAuth: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(cfg.baseUrl),
    resourceServerUrl: mcpUrl,
    scopesSupported: [MCP_SCOPE],
    resourceName: "Camberstack Google Ads",
    serviceDocumentationUrl: new URL(`${cfg.baseUrl}/#setup`),
  }));

  app.get("/oauth/google/callback", async (req, res) => {
    try {
      const to = await provider.completeGoogleCallback({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      });
      analytics.event(req, "connect");
      res.redirect(302, to);
    } catch (e) {
      res.status(400).type("html").send(errorPage(cfg.baseUrl, (e as Error).message));
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, bound to the caller.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const userId = String(req.auth?.extra?.userId ?? "");
    let session: UserSession | undefined;
    const clientId = req.auth?.clientId ?? null;
    const server = buildServer(() => (session ??= UserSession.load(deps, userId)), (c) => {
      logCall.run(now(), userId, clientId, c.tool, c.customerId, c.ok ? 1 : 0, c.error, c.ms, c.bytes);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    res.on("finish", () => {
      // Diagnostics for rejected requests only: method + protocol header, never arguments or data.
      if (res.statusCode >= 400) {
        const body = req.body as { method?: string } | { method?: string }[] | undefined;
        const method = Array.isArray(body) ? `batch[${body.map((b) => b?.method).join(",")}]` : body?.method;
        console.warn(`mcp ${res.statusCode} method=${method ?? "?"} protocol=${req.get("mcp-protocol-version") ?? "-"} accept=${req.get("accept") ?? "-"} ua=${req.get("user-agent") ?? "-"}`);
      }
    });
    try {
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

  const page = (html: string) => (_req: express.Request, res: express.Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(html);
  };
  app.get("/", page(homePage(cfg.baseUrl)));
  app.get("/privacy", page(privacyPage(cfg.baseUrl)));
  app.get("/terms", page(termsPage(cfg.baseUrl)));
  app.get("/robots.txt", (_q, r) => { r.type("text/plain").send(robotsTxt(cfg.baseUrl)); });
  app.get("/llms.txt", (_q, r) => { r.type("text/plain").send(llmsTxt(cfg.baseUrl)); });
  app.get("/sitemap.xml", (_q, r) => { r.type("application/xml").send(sitemapXml(cfg.baseUrl, cfg.gitCommitDate)); });
  // Brand assets: the SVG is the source; the PNGs are rendered from it (brand/).
  const brand = (file: string, type: string) => (_q: express.Request, r: express.Response) => {
    r.setHeader("Cache-Control", "public, max-age=86400");
    r.type(type).sendFile(file, { root: BRAND_DIR });
  };
  app.get("/favicon.svg", brand("logo.svg", "image/svg+xml"));
  app.get("/favicon.png", brand("favicon-32.png", "image/png"));
  app.get("/favicon.ico", brand("favicon-32.png", "image/png"));
  app.get("/logo.png", brand("logo-wordmark-480.png", "image/png"));
  // Page-view beacon (analytics.ts): only browsers that run JS are counted, which keeps bots out.
  app.get("/e.js", (_q, r) => { r.setHeader("Cache-Control", "public, max-age=86400"); r.type("application/javascript").send(BEACON_JS); });
  app.post("/e", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const b = parseBeacon(req.body ?? {});
    if (b) analytics.pageview(req, b.page, b.ref);
    res.status(204).end();
  });
  app.get("/healthz", (_q, r) => { r.json({ ok: true, version: SERVER_VERSION, sha: cfg.gitSha }); });

  app.use((_req, res) => { res.status(404).type("html").send(errorPage(cfg.baseUrl, "Page not found.")); });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);
  setInterval(() => sweep(db), 10 * 60_000).unref();
  createApp(cfg, db).listen(cfg.port, () => console.log(`camberstack-mcp ${SERVER_VERSION} on :${cfg.port} (${cfg.baseUrl})`));
}
