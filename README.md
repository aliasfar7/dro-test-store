# Dropship Test-Store Machine (DRO-2)

The fastest credible stack for hosting many one-product test pages and reaching a checkout
step. Static site generated from a single data file. Hosted checkout (Stripe Payment Link /
Shopify) is a per-product slot — no card data ever touches this site, which keeps processor
risk low.

**Live:** https://aliasfar7.github.io/dro-test-store/ (GitHub Pages, $0).
The build is host-portable — set `BASE_PATH=""` to move to Vercel/Netlify or a custom domain.

## Add a new test product in minutes

1. Add one object to the `products` array in [`data/products.json`](data/products.json).
2. `npm run deploy` — builds and publishes to the live URL.

That's it — a new live product page + checkout handoff. No code changes.
(`npm run build` alone just regenerates `public/` for local preview.)

### Product fields

| Field | Purpose |
|---|---|
| `slug` | URL: `/p/<slug>` (must be unique) |
| `active` | `false` hides it without deleting the data |
| `name`, `tagline`, `description` | Copy — keep **factual & policy-safe** (no fake reviews, no guarantees) |
| `price`, `compareAtPrice` | Display price + optional strike-through |
| `image`, `gallery[]` | Product photos |
| `benefits[]` | Bullet list |
| `shipping` | Shipping/returns line |
| `cogs`, `shippingCost` | Contribution-margin math — consumed by the DRO-3 dashboard (see [`DASHBOARD.md`](DASHBOARD.md); a test JSON can reference a product by `slug`) |
| `checkoutUrl` | **Hosted checkout link** (Stripe Payment Link or Shopify). Empty = checkout step shows "processor not connected". |
| `pixel.{meta,tiktok,ga4}` | Tracking IDs — override store-level pixels per product (DRO-5). Usually set `store.pixel` once for the one-product test. |

## How checkout works

Product page **Buy now** → `/checkout.html?p=<slug>` → order summary + email capture →
**Continue to secure payment** redirects to the product's `checkoutUrl` (hosted, PCI-safe).
Until a `checkoutUrl` is set, the checkout step renders but tells the buyer payment isn't
connected yet — so the page is testable today and goes live the moment a link is dropped in.

## Local

```bash
npm run build
npx serve public   # or any static server
```

## Payments (DRO-4)

Checkout is **hosted** (Stripe Payment Link / Shopify) — no card data touches this site, so
processor risk stays low. Drop the hosted URL into a product's `checkoutUrl` and it goes live.

- **Verify the charge+refund path:** `STRIPE_SECRET_KEY=sk_test_... npm run verify-charge`
  (automated $1 charge → capture → refund, risk-free). See [`PROCESSOR.md`](PROCESSOR.md).
- **Live $1 proof + refund runbook, and the "do not get frozen" checklist:** [`PROCESSOR.md`](PROCESSOR.md).
- Keys are read from the environment only — never committed (`.env.example`, `.gitignore`).

## What this is NOT

No custom backend, no card handling, no DB. Disposable by design — losers get `active:false`
and removed. Tracking (DRO-5) and live payments (DRO-4) plug into the slots above.

## Tracking & attribution (DRO-5)

Meta/TikTok/Google pixels + server-side Conversions APIs with **deduplicated** purchase events and a
canonical **UTM scheme** — so every test has trustworthy CAC/ROAS/CVR. Pixels stay dormant until ids
are configured (zero tracking code ships otherwise — safe to host anywhere). See **[`TRACKING.md`](TRACKING.md)**
for the UTM scheme, dedup design, the creds the CEO supplies, and how to verify:

```bash
npm run verify:tracking   # static wiring + dedup checks (no creds needed)
```

## Credentials / access still needed from CEO — see DRO-2 issue comment.
