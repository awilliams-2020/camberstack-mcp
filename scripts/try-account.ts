/**
 * Run the read-only tools against a real account with an existing Google refresh token, without
 * going through OAuth. For dogfooding before the Cloud project exists.
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… GOOGLE_ADS_DEVELOPER_TOKEN=… \
 *     npx tsx scripts/try-account.ts [customerId] [days]
 */
import { openDb } from "../src/db.js";
import { AdsClient, refreshGoogleToken } from "../src/google.js";
import { UserSession } from "../src/session.js";

const creds = { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN };
let tok: string | undefined;
const ads = new AdsClient(async () => (tok ??= (await refreshGoogleToken(creds, process.env.GOOGLE_REFRESH_TOKEN!)).access_token), creds.developerToken);
const s = new UserSession({ db: openDb(":memory:"), google: creds, encryptionKey: Buffer.alloc(32), freeApplies: 3, proEmails: new Set(), adsFactory: () => ads },
  { id: "dogfood", google_sub: "x", email: "dogfood", enc_refresh: null, plan: "free", created_at: 0, last_seen_at: null });
const accounts = await s.accounts();
console.log(JSON.stringify({ accounts }, null, 2));
const cid = process.argv[2] ?? accounts.find((a) => !a.manager)?.customerId;
if (cid) {
  const days = Number(process.argv[3] ?? 30);
  console.log(JSON.stringify(await s.overview(cid, days), null, 2));
}
