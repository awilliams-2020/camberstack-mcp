/** What the paid plan costs and includes: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$15/month";
/** Plans are sized in Google Ads accounts used over this rolling window (session.ts accountsInUse). */
export const ACCOUNT_WINDOW_DAYS = 30;
/** Error text the account gate starts with; lifecycle.ts finds blocked users by it in tool_calls. */
export const PLAN_LIMIT_PREFIX = "Plan limit:";

/** "1 Google Ads account" / "10 Google Ads accounts". */
export const accountsLabel = (n: number) => `${n} Google Ads account${n === 1 ? "" : "s"}`;
