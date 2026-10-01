/**
 * One-time, idempotent: create the Pro product + $49/month price (lookup_key means a re-run finds
 * it instead of duplicating), and report whether Stripe's customer portal is configured, which the
 * "manage billing" link needs. Prints STRIPE_PRO_PRICE_ID for the deploy's .env.
 *   STRIPE_SECRET_KEY=sk_... npx tsx scripts/setup-stripe.ts
 */
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("set STRIPE_SECRET_KEY"); process.exit(1); }
const api = async (path: string, form?: Record<string, string>) => {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data?.error?.message}`);
  return data;
};

const LOOKUP = "camberstack_pro_monthly_v1";
const found = await api(`prices/search?query=${encodeURIComponent(`lookup_key:'${LOOKUP}'`)}`);
let price = found.data?.[0];
if (!price) {
  const product = await api("products", {
    name: "Camberstack Pro",
    description: "Unlimited applied Google Ads changes from your AI assistant, with change history and undo.",
  });
  price = await api("prices", {
    product: product.id, currency: "usd", unit_amount: "4900",
    "recurring[interval]": "month", lookup_key: LOOKUP, nickname: "Pro monthly",
  });
  console.log("created", price.id);
} else console.log("already exists", price.id);
console.log(`STRIPE_PRO_PRICE_ID=${price.id}`);

const portals = await api("billing_portal/configurations?limit=10");
const active = (portals.data ?? []).filter((c: any) => c.active);
console.log(active.length
  ? `customer portal: configured (${active.length} active); cancel ${active[0].features?.subscription_cancel?.enabled ? "enabled" : "DISABLED"}`
  : "customer portal: NOT configured — save it once at dashboard.stripe.com/settings/billing/portal");
