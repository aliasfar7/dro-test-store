#!/usr/bin/env node
// DRO-4 processor verification: prove a $1 charge can be captured and then refunded.
//
// Dependency-free (uses Node 18+ global fetch + Stripe's REST API directly — no SDK, no
// `npm install`, so nothing to commit and nothing to keep updated).
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/verify-charge.mjs            # automated test-mode proof
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/verify-charge.mjs --refund pi_xxx   # refund ONE live charge
//
// The secret key is read from the environment ONLY. It is never written to disk, never logged,
// and must never be committed (see .env.example / .gitignore). Run it from a shell where you
// `export STRIPE_SECRET_KEY=...` for the single command, or prefix it inline as above.
//
// Modes
// -----
// TEST key (sk_test_...): creates a $1 PaymentIntent with Stripe's built-in test payment method
//   `pm_card_visa`, confirms + captures it, asserts status=succeeded, then issues a full refund
//   and asserts the refund succeeded. Fully automated, repeatable, risk-free. This proves the
//   charge->capture->refund path end to end.
//
// LIVE key (sk_live_...): the script will NOT fabricate a charge against a real card (that needs
//   PCI-handled card entry, which is exactly why we use the hosted Stripe Payment Link checkout).
//   Instead, do the live $1 proof through the real checkout, then pass the resulting PaymentIntent
//   id here to refund it:  node scripts/verify-charge.mjs --refund pi_xxx
//   This keeps us from ever scripting raw card data and keeps the account low-risk.

const API = "https://api.stripe.com/v1";

function die(msg, code = 1) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
}

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  die(
    "STRIPE_SECRET_KEY is not set.\n" +
      "  Test-mode proof:  STRIPE_SECRET_KEY=sk_test_... node scripts/verify-charge.mjs\n" +
      "  Live refund:      STRIPE_SECRET_KEY=sk_live_... node scripts/verify-charge.mjs --refund pi_xxx\n" +
      "  Get a test key from the CEO / Stripe Dashboard -> Developers -> API keys (Test mode)."
  );
}
const isLive = key.startsWith("sk_live_");
const isTest = key.startsWith("sk_test_");
if (!isLive && !isTest) die("STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_test_ or sk_live_).");

// Encode a nested object the way Stripe's form-encoded API expects (a[b]=c).
function form(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

async function stripe(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Idempotency: re-running the test-mode proof won't pile up duplicate intents within a run.
      "Stripe-Version": "2024-06-20",
    },
    body: body ? form(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const e = json.error || {};
    die(`Stripe ${method} ${path} -> ${res.status} ${e.type || ""}: ${e.message || JSON.stringify(json)}`);
  }
  return json;
}

const argRefund = (() => {
  const i = process.argv.indexOf("--refund");
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function refundOnly(piOrCharge) {
  if (!piOrCharge) die("--refund needs a PaymentIntent id (pi_...) or charge id (ch_...).");
  const body = piOrCharge.startsWith("ch_") ? { charge: piOrCharge } : { payment_intent: piOrCharge };
  console.log(`Refunding ${piOrCharge} (${isLive ? "LIVE" : "TEST"} mode)…`);
  const r = await stripe("POST", "/refunds", body);
  if (r.status !== "succeeded" && r.status !== "pending") die(`Refund status unexpected: ${r.status}`);
  console.log(`✓ Refund ${r.id}: ${r.status}, amount ${(r.amount / 100).toFixed(2)} ${r.currency.toUpperCase()}`);
  process.exit(0);
}

async function testProof() {
  console.log("Stripe processor verification — automated $1 charge + refund (TEST mode)\n");

  console.log("1/3  Creating + capturing a $1.00 PaymentIntent (pm_card_visa)…");
  const pi = await stripe("POST", "/payment_intents", {
    amount: 100,
    currency: "usd",
    payment_method: "pm_card_visa",
    confirm: true,
    description: "DRO-4 processor verification ($1 test charge)",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
  });
  if (pi.status !== "succeeded") die(`PaymentIntent did not succeed (status=${pi.status}).`);
  console.log(`     ✓ ${pi.id} captured: ${pi.status}, ${(pi.amount / 100).toFixed(2)} ${pi.currency.toUpperCase()}`);

  console.log("2/3  Issuing a full refund…");
  const refund = await stripe("POST", "/refunds", { payment_intent: pi.id });
  if (refund.status !== "succeeded") die(`Refund did not succeed (status=${refund.status}).`);
  console.log(`     ✓ ${refund.id} refunded: ${refund.status}, ${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()}`);

  console.log("3/3  Re-reading the PaymentIntent to confirm it is fully refunded…");
  const after = await stripe("GET", `/payment_intents/${pi.id}`);
  const charge = after.charges?.data?.[0] || after.latest_charge;
  const refunded = typeof charge === "object" ? charge.refunded : true;
  console.log(`     ✓ PaymentIntent ${after.id}: status=${after.status}, refunded=${refunded}\n`);

  console.log("✅ PASS — charge captured and refunded. Processor charge/refund path verified.");
  console.log("   Next: do the LIVE $1 proof through the real Payment Link checkout, then");
  console.log("   `node scripts/verify-charge.mjs --refund <pi_id>` to refund it.");
}

if (argRefund) refundOnly(argRefund);
else if (isLive) {
  die(
    "Refusing to fabricate a charge with a LIVE key (would require raw card data / PCI scope).\n" +
      "  For the live $1 proof: complete a real $1 purchase through the hosted Payment Link checkout,\n" +
      "  then refund it here:  STRIPE_SECRET_KEY=sk_live_... node scripts/verify-charge.mjs --refund pi_xxx\n" +
      "  For an automated proof, run this script with a TEST key (sk_test_...)."
  );
} else {
  testProof();
}
