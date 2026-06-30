# Payment Processor — Integration, Verification & "Do Not Get Frozen" (DRO-4)

Protecting processor standing is a **first-class deliverable**. A frozen Stripe account or a
reserve hold stops every product test cold — worse than a losing ad. This doc is the runbook.

## Architecture (why we're low-risk by design)

- **No card data ever touches our site.** Buyer flow is: product page → `/checkout.html?p=<slug>`
  (order summary + email) → redirect to a **hosted** Stripe Payment Link / Shopify checkout.
  Card entry, PCI scope, 3DS/SCA all live on Stripe's domain. We hold zero PAN data.
- **One product per Payment Link**, price and descriptor fixed server-side at Stripe. The store
  can't be tricked into charging the wrong amount.
- **Disposable & honest pages.** Copy is factual, no fake reviews, no guarantees, no countdown
  lies — the #1 driver of disputes and processor review is a page that overpromises.

## Verification — the $1 charge + refund proof

Script: [`scripts/verify-charge.mjs`](scripts/verify-charge.mjs) — dependency-free (Node 18+ global
`fetch`, Stripe REST directly, no SDK/`npm install`). Reads `STRIPE_SECRET_KEY` from the
environment **only** — never logged, never written to disk, never committed (see `.env.example`).

### A. Automated proof (TEST mode) — risk-free, do this first

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/verify-charge.mjs
```

Creates a $1.00 PaymentIntent with Stripe's `pm_card_visa`, captures it, asserts `succeeded`,
issues a full refund, asserts the refund succeeded, re-reads the intent to confirm `refunded`.
Fully automated and repeatable. **This proves the charge → capture → refund path end to end.**

### B. Live proof (LIVE mode) — the acceptance-criteria $1 charge

The script will **not** fabricate a live charge (that needs raw card data / PCI scope — exactly
what we avoid). Do the real thing through the hosted checkout, then refund by id:

1. CEO creates a **$1.00 Stripe Payment Link** (or a $1 Shopify test product) on the live account.
2. Paste that URL into the product's `checkoutUrl` in `data/products.json`, `npm run deploy`.
3. Complete one real $1.00 purchase end to end through the live checkout (real card).
4. Grab the `pi_...` id from Stripe Dashboard → Payments.
5. Refund it:
   ```bash
   STRIPE_SECRET_KEY=sk_live_... node scripts/verify-charge.mjs --refund pi_...
   ```
6. Confirm in Dashboard the payment shows **Refunded**. ✅ Acceptance criterion met.

> Net cost of the live proof: $0 (the $1 is refunded). Stripe's per-refund fee on a $1 charge is
> negligible; the processing fee on the original charge is not returned on refund, so the true
> cost is ~$0.33 — acceptable for a one-time go-live proof.

---

## "Do Not Get Frozen" checklist

Run before turning on **any** live spend, and re-check whenever volume or product changes.

### Account setup (one-time, before first live charge)
- [ ] Business details on the Stripe account are accurate (legal name, address, real support email + phone).
- [ ] **Statement descriptor** is set to something the buyer will recognize and is on the site/receipt.
      Mismatched descriptor → "I don't recognize this charge" → dispute. This is the single biggest
      freeze trigger for dropship.
- [ ] Bank account verified; payout schedule known.
- [ ] Refund & shipping/returns policy is **live and linked** on the store (checkout + footer).
- [ ] Realistic **fulfillment/shipping times** stated on the product page. Dropship ships slow;
      under-promising delivery is the #2 dispute driver. Say "ships in X–Y days" and mean it.

### Page / policy compliance (protects ad accounts too — see DRO-2)
- [ ] No fake reviews, fake scarcity, fake discounts, or health/income guarantees.
- [ ] Claims are factual and substantiated; no restricted/prohibited products (Stripe restricted list).
- [ ] Working contact method + visible business identity on every page.
- [ ] Checkout total == advertised price == Payment Link amount (no surprise fees).

### Ramp discipline (avoid the velocity-spike freeze)
- [ ] First live week: keep daily volume low and steady. A cold account that suddenly does
      $5k/day looks like fraud/laundering and gets auto-reviewed or reserved. Ramp gradually.
- [ ] Watch the **dispute rate**. Card networks flag at ~**0.65–1.0%** of transactions; Stripe
      may reserve/freeze well before that. Target **< 0.5%**. One dispute per ~200 orders, max.
- [ ] Watch the **refund/return rate**. A high refund rate also signals product/expectation
      mismatch and draws review. Fix the page or kill the product, don't let it ride.
- [ ] Keep some balance/payout buffer so a clawback doesn't force a negative balance.

### Ongoing dispute & chargeback hygiene
- [ ] **Respond fast and proactively to disputes** in Stripe Dashboard with evidence: order,
      tracking/fulfillment, the policy the buyer agreed to, comms. Unanswered disputes auto-lose.
- [ ] **Refund first, fight later.** If a buyer is unhappy, refund before it becomes a chargeback —
      a refund costs us the processing fee; a chargeback costs the fee **+ a ~$15 dispute fee +**
      counts against our dispute ratio. Refunds are cheap insurance for account health.
- [ ] Enable Stripe **Radar** (default rules) for fraud screening; enable **3DS/SCA** where prompted.
- [ ] Reconcile refunds/disputes into the DRO-3 dashboard so margin reflects true net.
- [ ] Never argue with the buyer, never withhold refunds to "save margin" — the account is worth
      far more than any single order.

### If review/freeze risk appears
- [ ] Pause ad spend immediately (stop new volume into a flagged account).
- [ ] Respond to every Stripe email/info request within the deadline with complete documentation.
- [ ] Escalate to CEO same-day — a processor hold is a company-level emergency, not a quiet retry.

---

## Credentials needed from CEO (blocker for the live $1 proof)

The integration is **built and the verification is automated**; it needs one input to go live:

1. A **Stripe test secret key** (`sk_test_...`) → I run proof **A** immediately (risk-free, automated).
2. For the acceptance-criteria **live** $1 charge: a live Stripe account with a **$1 Payment Link**
   (or Shopify Payments enabled) so we can run proof **B**. CEO completes the one real purchase;
   I refund it via the script.

Provide keys **out of band** (not in the repo, not in a ticket comment) — e.g. paste into the
agent environment as `STRIPE_SECRET_KEY`, or set it in the deploy host's secret store. The script
and `.gitignore`/`.env.example` are set up so a key never lands in git.
