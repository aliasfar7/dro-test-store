# Per-Test Measurement Dashboard + Margin Calculator (DRO-3)

**One job:** for any single product test, take the spend / revenue / cost numbers
and give a clear **NET-POSITIVE / KILL** verdict, plus CAC, ROAS, CVR, AOV. This
is the yardstick *every* product test is judged against, so the math lives in one
place and is identical across the script and the page.

Nothing to install. Two front-ends, same formulas:

| You want… | Use | How |
|---|---|---|
| Type numbers, see the verdict (no terminal) | `dashboard.html` | Open it in any browser |
| Repeatable / saved / automatable reports | `margin.py` | `python3 margin.py examples/<test>.json` |

---

## TL;DR for the CEO — reading a verdict

Open **`dashboard.html`**, type the test's numbers in the left column. The right
column updates live:

- **Big green `NET-POSITIVE`** → the test makes money *after* COGS, shipping,
  processor fees, **and** ad spend. A candidate to keep testing / scale.
- **Big red `KILL`** → it loses money after all costs (or the product loses money
  on every sale *before* ads — unfixable). Tear it down.
- **`LOW CONFIDENCE` pill** → too few orders (< 5) or too little spend (< $50) to
  trust the number yet. Keep the test running before acting on it.
- **`THIN MARGIN` pill** → positive, but net margin is under 10%. Real but fragile;
  a small CPM rise or refund flips it negative. Treat as "watch", not "scale".
- **⚠ PROCESSOR RISK** → dispute rate > 1% or refund rate > 20%. This can get the
  payment processor frozen. Flag to engineering immediately, regardless of verdict.

The verdict is decided on **one number: NET CONTRIBUTION** (bottom of the
waterfall). Positive = makes money, negative = loses money.

---

## The model (what the verdict means)

```
  Net revenue        = revenue − refunds
  − COGS             = cogs_total      OR  cogs_per_unit × units
  − Shipping         = shipping_total  OR  shipping_per_order × orders
  − Processor fees   = fees_total      OR  revenue × rate% + orders × fixed_fee
  ─────────────────────────────────────────────────────────────────────────
  = GROSS CONTRIBUTION   (margin from the product itself, before any ads)
  − Ad spend
  ─────────────────────────────────────────────────────────────────────────
  = NET CONTRIBUTION     ← the verdict is the sign of this number
```

**Verdict rules**

1. If gross contribution ≤ 0 → **KILL** ("upside-down": no ad efficiency can save
   a product that loses money on every unit sold).
2. Else if net contribution > 0 → **NET-POSITIVE**.
3. Else → **KILL** (the ad cost outruns the product's margin).

---

## Reported metrics

| Metric | Formula | Reads as |
|---|---|---|
| **AOV** | net revenue ÷ orders | average order value |
| **CVR** | orders ÷ sessions | conversion rate |
| **CAC** | ad spend ÷ orders | cost to acquire one customer |
| **ROAS** | net revenue ÷ ad spend | revenue per ad dollar |
| **Break-even ROAS** | net revenue ÷ gross contribution | the ROAS you must beat to not lose money |
| **Net margin %** | net contribution ÷ net revenue | profit as a % of sales |
| **Contribution / order** | gross contribution ÷ orders | margin each order throws off before ads |
| **Max allowable CAC** | = contribution / order | the most you can pay per customer and still break even |
| **CAC headroom** | max allowable CAC − actual CAC | positive = room to spend more; negative = overpaying |

Two fast gut-checks: **ROAS > break-even ROAS** ⇔ net-positive, and
**CAC < max allowable CAC** ⇔ net-positive. They always agree with the verdict.

---

## Judging thresholds (the company's bar — edit in ONE place)

Defined once at the top of `margin.py` and mirrored in `dashboard.html`:

| Threshold | Default | Meaning |
|---|---|---|
| `MIN_ORDERS_FOR_CONFIDENCE` | 5 | fewer orders ⇒ `LOW CONFIDENCE` |
| `MIN_SPEND_FOR_CONFIDENCE` | $50 | less spend ⇒ `LOW CONFIDENCE` |
| `THIN_MARGIN_PCT` | 10% | net margin under this ⇒ `THIN MARGIN` |
| `DISPUTE_RATE_WARN_PCT` | 1% | chargebacks/orders above this ⇒ processor-risk warning |
| `REFUND_RATE_WARN_PCT` | 20% | refunds/revenue above this ⇒ processor-risk warning |

Processor defaults are Stripe / Shopify Payments standard: **2.9% + $0.30/txn**.
Override per-test with `processor_rate_pct` / `processor_fixed_fee`, or pass the
exact `processor_fees_total` from a payout report.

---

## Inputs (a test JSON)

A flat object; money in dollars. Give either the `*_total` **or** the per-unit
field for each cost (`*_total` wins if both are present).

```jsonc
{
  "name": "glow-serum-meta-test-01",
  "ad_spend": 300.0,            // total paid acquisition spend
  "revenue": 540.0,             // gross revenue charged (before refunds)
  "refunds": 30.0,              // refunded amount        (default 0)
  "orders": 18,                 // paid order count
  "units": 18,                  // total units (default = orders)
  "sessions": 1200,             // ad-driven sessions/clicks (for CVR)
  "chargebacks": 0,             // dispute count (guardrail; default 0)
  "cogs_per_unit": 6.50,        // OR  "cogs_total": 117.0
  "shipping_per_order": 4.00,   // OR  "shipping_total": 72.0
  "processor_rate_pct": 2.9,    // OR  "processor_fees_total": 21.06
  "processor_fixed_fee": 0.30
}
```

**Pull costs from the store catalog.** Instead of typing COGS/shipping, reference
a product `slug` from the DRO-2 store's `data/products.json` — its `cogs` and
`shippingCost` fields fill in automatically (explicit values still win):

```json
{ "product": "sample-product", "ad_spend": 100.0, "revenue": 500.0, "orders": 12, "sessions": 800 }
```

> **Fee assumption:** processor fees are computed on **gross** revenue (fees are
> taken at charge time) plus the fixed fee per order. For an exact read, paste the
> processor's actual fee total into `processor_fees_total`.

---

## Running `margin.py`

```bash
python3 margin.py examples/glow-serum-meta-test-01.json   # pretty report
python3 margin.py examples/sample-product-test.json       # costs from store catalog
python3 margin.py examples/winner-demo.json               # a clear winner
python3 margin.py examples/winner-demo.json --json        # machine-readable
cat examples/winner-demo.json | python3 margin.py -        # from stdin
python3 margin.py --example                                # built-in sample
python3 margin.py --self-test                              # verify the formulas
```

`evaluate()` is a pure function returning the full report dict, so a future report
job can `from margin import TestInputs, evaluate` and reuse the exact judging logic
— no second copy of the math.

---

## Verifying it works

`python3 margin.py --self-test` locks the formulas and the verdict bands with
hand-computed expectations (winner, kill, upside-down, low-confidence, processor
risk, store-catalog lookup). Run it after any edit to `margin.py`. The HTML mirrors
the same numbers — parity was checked against the script on the shipped examples.

---

## Scope / non-goals

Deliberately lightweight and disposable, per the "cheap, fast, disciplined
testing" mandate. No database, no server, no build step — a script and a single
HTML file. Per-test inputs are entered by hand or dropped in as JSON; auto-ingesting
spend/revenue from the ad and Shopify APIs is a **separate**, later ticket worth
building only once a product clears the net-positive bar.
