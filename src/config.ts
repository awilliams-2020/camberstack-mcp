/** Every environment variable the service reads, in one place. */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export interface Config {
  /** Public origin, no trailing slash. Issuer for OAuth and base of every link. */
  baseUrl: string;
  port: number;
  dataDir: string;
  /** 32-byte key (hex or base64) that encrypts Google refresh tokens at rest. */
  encryptionKey: Buffer;
  google: {
    clientId: string;
    clientSecret: string;
    /** Sent when set. Google moved access decisions to the Cloud project on 2026-09-10. */
    developerToken?: string;
  };
  /** When false (beta), every connected user may apply approved changes. */
  applyRequiresPro: boolean;
  /** Emails treated as Pro regardless of billing (the operator, testers). */
  proEmails: Set<string>;
  /** Google accounts allowed into /admin. Empty = /admin does not exist (404). */
  adminEmails: Set<string>;
  /** Self-hosted Matomo for the public pages; unset = no analytics. See analytics.ts. */
  matomo?: { url: string; siteId: string; token: string };
  gitSha: string;
  gitCommitDate: string;
}

export function parseKey(raw: string): Buffer {
  const hex = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (hex.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)");
  return hex;
}

export function loadConfig(): Config {
  return {
    baseUrl: (process.env.BASE_URL ?? "https://camberstack.io").replace(/\/+$/, ""),
    port: Number(process.env.PORT ?? 3000),
    dataDir: process.env.DATA_DIR ?? "./data",
    encryptionKey: parseKey(req("ENCRYPTION_KEY")),
    google: {
      // Optional so the public pages can go live before the Google Cloud project exists (brand
      // verification needs the homepage first). Without them, sign-in reports "not open yet".
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || undefined,
    },
    applyRequiresPro: process.env.APPLY_REQUIRES_PRO === "true",
    proEmails: new Set(
      (process.env.PRO_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ),
    adminEmails: new Set(
      (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ),
    matomo: process.env.MATOMO_URL && process.env.MATOMO_SITE_ID
      ? { url: process.env.MATOMO_URL, siteId: process.env.MATOMO_SITE_ID, token: process.env.MATOMO_AUTH_TOKEN ?? "" }
      : undefined,
    gitSha: process.env.GIT_SHA ?? "",
    gitCommitDate: process.env.GIT_COMMIT_DATE ?? "",
  };
}
