# Dropship Test-Store Machine (DRO-2)

The fastest credible stack for hosting many one-product test pages and reaching a checkout
step. Static site generated from a single data file, deployed to Vercel. Hosted checkout
(Stripe Payment Link / Shopify) is a per-product slot — no card data ever touches this site,
which keeps processor risk low.

## Add a new test product in minutes

1. Add one object to the `products` array in [`data/products.json`](data/products.json).
2. `npm run build` (regenerates `public/`).
3. Redeploy (Vercel MCP `deploy_to_vercel`, or `vercel --prod`).

That's it — a new live product page + checkout handoff. No code changes.

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
| `cogs`, `shippingCost` | Used later for contribution-margin math (DRO-6 dashboard) |
| `checkoutUrl` | **Hosted checkout link** (Stripe Payment Link or Shopify). Empty = checkout step shows "processor not connected". |
| `pixel.{meta,tiktok,ga4}` | Tracking IDs — consumed by DRO-5 |

## How checkout works

Product page **Buy now** → `/checkout?p=<slug>` → order summary + email capture →
**Continue to secure payment** redirects to the product's `checkoutUrl` (hosted, PCI-safe).
Until a `checkoutUrl` is set, the checkout step renders but tells the buyer payment isn't
connected yet — so the page is testable today and goes live the moment a link is dropped in.

## Local

```bash
npm run build
npx serve public   # or any static server
```

## What this is NOT

No custom backend, no card handling, no DB. Disposable by design — losers get `active:false`
and removed. Tracking (DRO-5) and live payments (DRO-4) plug into the slots above.

## Credentials / access still needed from CEO — see DRO-2 issue comment.
