# Tracking & Conversion APIs (DRO-5)

End-to-end measurement for the test-store machine: ad pixels + server-side Conversions APIs with
**deduplication**, a clean **UTM scheme**, and a deduplicated **Purchase** event — so every product
test yields trustworthy CAC / ROAS / CVR. Attribution accuracy is the whole point; a wrong read
wastes weeks of ad budget.

## What's wired

| Layer | Meta | TikTok | Google |
|---|---|---|---|
| **Browser pixel** | Meta Pixel (`fbq`) | TikTok Pixel (`ttq`) | GA4 (`gtag`) |
| **Server-side** | Conversions API | Events API | Measurement Protocol |
| **Events** | PageView · ViewContent · InitiateCheckout · Purchase | Pageview · ViewContent · InitiateCheckout · CompletePayment | page_view · view_item · begin_checkout · purchase |

- **Client:** [`src/track.js`](src/track.js) → built to `public/assets/track.js`. Initializes each
  pixel **only if its id is configured** (empty id = pixel simply absent — no broken/empty pixels),
  captures UTMs, and fires standard events. Auto-fires `PageView` everywhere and `ViewContent` on
  product pages.
- **Server:** [`api/capi.js`](api/capi.js) (Vercel function) → [`scripts/lib/capi.mjs`](scripts/lib/capi.mjs)
  (shared sender, also used by the verify script and reusable by the DRO-4 Stripe webhook later).
- **Config:** pixel ids and the CAPI endpoint live in [`data/products.json`](data/products.json)
  (`store.pixel.{meta,tiktok,ga4}`, `store.capiEndpoint`); a product may override `pixel`. **No secrets
  in the repo** — CAPI access tokens are server env vars only (see [`.env.example`](.env.example)).

## Deduplication (the core guarantee)

A purchase is reported **twice** — once by the browser pixel, once by the server CAPI — for resilience
(ad-blockers / iOS kill the browser event ~10-30% of the time). To avoid double-counting, both reports
carry the **same `event_id`**:

```
checkout.html (Buy)  ─ pre-mint event_id ─┐
                                          ├─► localStorage(dro_pending) + client_reference_id in checkout URL
hosted checkout (Stripe/Shopify) ─────────┘
        │  after-payment redirect
        ▼
thank-you.html ──► browser pixel  Purchase {eventID: id}   ┐
              └──► POST /api/capi  Purchase {event_id: id}  ┘  Meta/TikTok/GA4 dedup on this id → 1 conversion
```

Meta dedups on `(event_name, event_id)`, TikTok on `event_id`, GA4 on `transaction_id`.

## UTM scheme (apply to every ad URL)

All paid traffic **must** land with these params; `track.js` captures them (first-touch persisted +
last-touch updated), and they ride through to the processor URL and the CAPI payload.

| Param | Values / convention | Example |
|---|---|---|
| `utm_source` | platform: `meta` · `tiktok` · `google` | `meta` |
| `utm_medium` | `paid_social` (FB/IG/TT) · `cpc` (Google search) · `paid_video` | `paid_social` |
| `utm_campaign` | `{product-slug}_{objective}_{yyyymm}` | `sample-product_purchase_202606` |
| `utm_content` | ad / creative id | `ad_ugc_v3` |
| `utm_term` | ad set / audience | `lookalike_us_1pct` |

Click ids (`fbclid`, `ttclid`, `gclid`) are captured automatically and forwarded to CAPI for match
quality — **do not strip them.** Example tagged URL:

```
https://store/p/sample-product.html?utm_source=meta&utm_medium=paid_social&utm_campaign=sample-product_purchase_202606&utm_content=ad_ugc_v3&utm_term=lookalike_us_1pct
```

Use one UTM per ad (Meta/TikTok/Google all support URL params at the ad level). Keep them consistent —
the dashboard (DRO-3) reads `utm_source` to attribute spend/revenue.

## Go-live: supply credentials, then verify (CEO-owned access)

1. **Get access** (CEO): a Meta Pixel id + a Conversions API access token (Events Manager → Settings →
   Conversions API → Generate access token); optionally TikTok Pixel id + Events API token, and a GA4
   Measurement id + Measurement-Protocol API secret.
2. **Configure pixels** (no secrets): set `store.pixel.{meta,tiktok,ga4}` and `store.capiEndpoint`
   (`/api/capi` on Vercel) in `data/products.json`, then `npm run build`.
3. **Configure tokens** (secrets → host env only): set `META_PIXEL_ID`, `META_CAPI_TOKEN`,
   `META_TEST_EVENT_CODE` (and TikTok/GA4 equivalents) in Vercel → Project → Environment Variables.
   Never commit them. See [`.env.example`](.env.example).
4. **Prove it:**
   ```bash
   # Static wiring + dedup (no creds needed):
   npm run verify:tracking
   # Live Meta Test Event (shows up in Events Manager → Test Events):
   META_PIXEL_ID=... META_CAPI_TOKEN=... META_TEST_EVENT_CODE=TESTxxxxx npm run verify:tracking
   ```
   Then do one real $1 checkout (DRO-4) and confirm **one** deduplicated Purchase in Events Manager.

## Ad-account / processor safety

- Pixels load async; pages are `noindex`; no redirects, no cloaking, no PII sent unhashed (emails are
  SHA-256 hashed server-side before CAPI).
- With no ids configured the pages ship **zero** tracking code — safe to host anywhere.
- `api/capi` only runs on a function host (Vercel). On static-only hosts (GitHub Pages) the browser
  pixel still fires; there's just no server partner to dedup with — migrate to Vercel before scaling.
