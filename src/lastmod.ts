/**
 * Honest sitemap <lastmod> per page, and IndexNow pings for the pages that changed.
 *
 * The sitemap used to stamp every page with the build's commit date, so /privacy "changed" on every deploy. Google
 * learns a site's lastmod is unreliable and stops using it. Instead each page's rendered HTML (minus the shared
 * inline CSS, which is styling, not content) is hashed at boot; a page's date moves only when its hash does.
 *
 * IndexNow (Bing, Yandex, Seznam, Naver; Bing feeds ChatGPT search and Copilot) is told about pages seen for the first
 * time or changed since the last boot. The key is public by design (served at /<key>.txt), so it is derived, not stored.
 */
import { createHash } from "node:crypto";
import type { DB } from "./db.js";
import { deriveKey } from "./crypto.js";

const today = () => new Date().toISOString().slice(0, 10);
const contentHash = (html: string) => createHash("sha256").update(html.replace(/<style>[\s\S]*?<\/style>/g, "")).digest("hex");

export const indexNowKey = (encryptionKey: Buffer) => deriveKey(encryptionKey, "indexnow").toString("hex").slice(0, 32);

/**
 * Records each page's content hash; returns its last-changed date and which paths are new or changed.
 * `seed` dates a page seen for the first time (the build's commit date: what the sitemap claimed before this existed).
 */
export function pageDates(db: DB, pages: Record<string, string>, seed: string): { dates: Record<string, string>; changed: string[] } {
  const get = db.prepare("SELECT hash, changed FROM page_versions WHERE path = ?");
  const put = db.prepare("INSERT INTO page_versions (path, hash, changed) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, changed = excluded.changed");
  const dates: Record<string, string> = {};
  const changed: string[] = [];
  for (const [path, html] of Object.entries(pages)) {
    const h = contentHash(html);
    const row = get.get(path) as { hash: string; changed: string } | undefined;
    if (row?.hash === h) { dates[path] = row.changed; continue; }
    const d = row ? today() : (seed.slice(0, 10) || today());
    put.run(path, h, d);
    dates[path] = d;
    changed.push(path);
  }
  return { dates, changed };
}

/** POSTs the changed URLs to IndexNow. One request covers every participating engine. */
export async function pingIndexNow(baseUrl: string, key: string, paths: string[], f: typeof fetch = fetch): Promise<void> {
  if (!paths.length) return;
  const host = new URL(baseUrl).host;
  const res = await f("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key, keyLocation: `${baseUrl}/${key}.txt`, urlList: paths.map((p) => `${baseUrl}${p}`) }),
    signal: AbortSignal.timeout(15_000),
  });
  // 200 OK, 202 Accepted (key not yet verified). Anything else is worth a log line, never a crash.
  if (res.status !== 200 && res.status !== 202) throw new Error(`IndexNow ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
