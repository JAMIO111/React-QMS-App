#!/usr/bin/env node
// Creates (or finds) the Stripe products and the six GBP prices (observer / contributor / controller, monthly and annual) and prints the SQL that records
// their ids against our price rows. Safe to run again: prices are found by lookup key, never duplicated. Run it per Stripe mode (test, then live).
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs            # creates what is missing, prints SQL
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --dry-run  # only reports what it would create
//
// Review the SQL it prints, then run it against the matching Supabase project (test keys <-> the dev project). The amounts mirror
// supabase/migrations/20251110100000_subscriptions.sql (pence, excluding VAT; annual = 10 x monthly); change them in the database first, then here.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_(test|live)_/.test(key)) {
  console.error('Set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_... or sk_live_...).');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
// STRIPE_USE_FETCH=1 makes the client use fetch instead of Node's http module: needed behind an HTTP(S) proxy (run with NODE_USE_ENV_PROXY=1).
const stripe = new Stripe(key, {
  appInfo: { name: 'Fortress QMS setup' },
  ...(process.env.STRIPE_USE_FETCH ? { httpClient: Stripe.createFetchHttpClient() } : {}),
});

const PLANS = [
  { slug: 'observer', name: 'Fortress QMS Observer', description: 'Read-only access to company quality information.', monthly: 500 },
  { slug: 'contributor', name: 'Fortress QMS Contributor', description: 'Record results and complete assigned work.', monthly: 1000 },
  { slug: 'controller', name: 'Fortress QMS Controller', description: 'Full application functionality, subject to company permissions.', monthly: 2500 },
];
const INTERVALS = [
  { interval: 'month', factor: 1 },
  { interval: 'year', factor: 10 },
];

const sql = [];
for (const plan of PLANS) {
  let productId;
  const found = await stripe.products.search({ query: `metadata['plan_slug']:'${plan.slug}' AND active:'true'` });
  if (found.data[0]) productId = found.data[0].id;
  else if (dryRun) console.log(`would create product ${plan.name}`);
  else productId = (await stripe.products.create({ name: plan.name, description: plan.description, metadata: { plan_slug: plan.slug }, tax_code: 'txcd_10103001' })).id; // SaaS, business use

  for (const { interval, factor } of INTERVALS) {
    const lookupKey = `fortress_${plan.slug}_${interval}`;
    const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
    let price = existing;
    if (!price && productId && !dryRun) {
      price = await stripe.prices.create({
        product: productId,
        currency: 'gbp',
        unit_amount: plan.monthly * factor,
        recurring: { interval },
        tax_behavior: 'exclusive',
        lookup_key: lookupKey,
        metadata: { plan_slug: plan.slug },
      });
      console.log(`created ${lookupKey} = ${price.id}`);
    } else if (price) {
      const amount = plan.monthly * factor;
      if (price.unit_amount !== amount) console.warn(`WARNING: ${lookupKey} is ${price.unit_amount} in Stripe but ${amount} here. Prices are immutable: create a new price (new lookup key) and a new database price row.`);
      console.log(`found   ${lookupKey} = ${price.id}`);
    } else {
      console.log(`would create ${lookupKey}`);
    }
    if (price) {
      sql.push(
        `UPDATE public.subscription_prices SET provider_price_id = '${price.id}' WHERE active AND effective_to IS NULL AND currency = 'GBP' AND billing_interval = '${interval}'\n` +
          `  AND subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = '${plan.slug}');`,
      );
    }
  }
}
console.log(`\n-- Run against the matching Supabase project (${key.includes('_live_') ? 'LIVE' : 'test'} mode):\n${sql.join('\n')}`);
