/**
 * One-time, idempotent: create the Pro product + $15/month price (lookup_key means a re-run finds
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

// v1 was $49/month (2026-10-01 → 10-04); Stripe prices are immutable, so a price change is a new
// lookup key on the SAME product. Existing v1 subscribers stay on v1 unless moved.
const LOOKUP = "camberstack_pro_monthly_v2";
const byLookup = async (k: string) =>
  (await api(`prices/search?query=${encodeURIComponent(`lookup_key:'${k}'`)}`)).data?.[0];
let price = await byLookup(LOOKUP);
if (!price) {
  const prior = await byLookup("camberstack_pro_monthly_v1");
  const product = prior ? { id: prior.product } : await api("products", {
    name: "Camberstack Pro",
    description: "Unlimited applied Google Ads changes from your AI assistant, with change history and undo.",
  });
  price = await api("prices", {
    product: product.id, currency: "usd", unit_amount: "1500",
    "recurring[interval]": "month", lookup_key: LOOKUP, nickname: "Pro monthly",
  });
  console.log("created", price.id);
} else console.log("already exists", price.id);
console.log(`STRIPE_PRO_PRICE_ID=${price.id}`);

// Customer portal: where Pro users change card, see invoices and cancel (at period end, matching the
// terms). Created here if none is active; billing.ts uses the default, else the first active one.
const portals = await api("billing_portal/configurations?limit=10&active=true");
if (portals.data?.length) {
  const c = portals.data[0];
  console.log(`customer portal: already configured (${c.id}); cancel ${c.features?.subscription_cancel?.enabled ? c.features.subscription_cancel.mode : "DISABLED"}`);
} else {
  const c = await api("billing_portal/configurations", {
    "business_profile[headline]": "Camberstack Pro: manage your subscription",
    "business_profile[privacy_policy_url]": "https://camberstack.io/privacy",
    "business_profile[terms_of_service_url]": "https://camberstack.io/terms",
    default_return_url: "https://camberstack.io",
    "features[payment_method_update][enabled]": "true",
    "features[invoice_history][enabled]": "true",
    "features[customer_update][enabled]": "true",
    "features[customer_update][allowed_updates][0]": "email",
    "features[customer_update][allowed_updates][1]": "address",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_cancel][cancellation_reason][enabled]": "true",
    "features[subscription_cancel][cancellation_reason][options][0]": "too_expensive",
    "features[subscription_cancel][cancellation_reason][options][1]": "unused",
    "features[subscription_cancel][cancellation_reason][options][2]": "missing_features",
    "features[subscription_cancel][cancellation_reason][options][3]": "switched_service",
    "features[subscription_cancel][cancellation_reason][options][4]": "other",
  });
  console.log(`customer portal: created ${c.id} (default: ${c.is_default})`);
}
