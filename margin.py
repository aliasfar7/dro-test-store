#!/usr/bin/env python3
"""Dropship per-test measurement dashboard + margin calculator.

Single source of truth for how every product test is judged. Ingests a test's
spend / revenue / COGS / shipping / processor-fee inputs and outputs:

  * Contribution margin (before AND after ad spend)
  * A clear NET-POSITIVE / KILL verdict (with a low-confidence flag on thin data)
  * CAC, ROAS, CVR, AOV
  * Break-even ROAS, max allowable CAC, and CAC headroom
  * Processor / ad-account health guardrail warnings

The CEO can read a verdict without an engineer present:  see README.md.

Usage:
    python3 margin.py path/to/test.json
    python3 margin.py --example
    python3 margin.py --self-test
    cat test.json | python3 margin.py -

A test JSON is a flat object of inputs (see DEFAULTS / examples below). Money
is in dollars. The same formulas are mirrored in dashboard.html.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, asdict

# ----------------------------------------------------------------------------
# Judging thresholds. These define the company's bar for a product test.
# Tune here (and they are documented in README.md) -- nowhere else.
# ----------------------------------------------------------------------------
DEFAULT_PROCESSOR_RATE_PCT = 2.9   # Stripe / Shopify Payments standard
DEFAULT_PROCESSOR_FIXED = 0.30     # per successful transaction
MIN_ORDERS_FOR_CONFIDENCE = 5      # below this, the read is noise -> keep testing
MIN_SPEND_FOR_CONFIDENCE = 50.0    # below this, not enough ad data to judge CAC
THIN_MARGIN_PCT = 10.0             # net margin under this % of revenue = "thin"
DISPUTE_RATE_WARN_PCT = 1.0        # chargeback rate above this risks the processor
REFUND_RATE_WARN_PCT = 20.0        # refund rate above this risks the processor


def _money(x) -> float:
    return round(float(x), 2)


@dataclass
class TestInputs:
    """All inputs for one product test. Provide totals OR per-unit fields."""
    name: str = "untitled-test"
    # Top line
    ad_spend: float = 0.0           # total paid acquisition spend
    revenue: float = 0.0            # gross revenue charged (before refunds)
    refunds: float = 0.0            # refunded amount (reduces net revenue)
    orders: int = 0                 # count of paid orders
    units: int | None = None        # total product units (default = orders)
    sessions: int = 0               # ad-driven sessions/visitors (for CVR)
    chargebacks: int = 0            # dispute count (guardrail only)
    # Costs -- give the *_total OR the per-* variant; total wins if both set.
    cogs_total: float | None = None
    cogs_per_unit: float = 0.0
    shipping_total: float | None = None
    shipping_per_order: float = 0.0
    processor_fees_total: float | None = None
    processor_rate_pct: float = DEFAULT_PROCESSOR_RATE_PCT
    processor_fixed_fee: float = DEFAULT_PROCESSOR_FIXED

    @staticmethod
    def from_dict(d: dict) -> "TestInputs":
        d = resolve_product_costs(d)
        known = {f for f in TestInputs.__dataclass_fields__}
        unknown = set(d) - known
        if unknown:
            raise ValueError(f"Unknown input field(s): {sorted(unknown)}. "
                             f"Allowed: {sorted(known)}")
        return TestInputs(**d)


# Default location of the store's product catalog (DRO-2 test-store machine).
PRODUCTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "data", "products.json")


def resolve_product_costs(d: dict) -> dict:
    """If the test references a store product by slug, pull its cost fields from
    data/products.json so COGS/shipping have a single source of truth. Explicit
    values in the test JSON always win. The ``product`` key is consumed here.
    """
    if "product" not in d:
        return d
    d = dict(d)
    slug = d.pop("product")
    try:
        with open(PRODUCTS_PATH) as fh:
            catalog = json.load(fh)
    except FileNotFoundError:
        raise ValueError(f"product '{slug}' referenced but {PRODUCTS_PATH} not found")
    match = next((p for p in catalog.get("products", []) if p.get("slug") == slug), None)
    if match is None:
        slugs = [p.get("slug") for p in catalog.get("products", [])]
        raise ValueError(f"product slug '{slug}' not found. Known: {slugs}")
    d.setdefault("name", f"{slug}-test")
    if "cogs" in match:
        d.setdefault("cogs_per_unit", match["cogs"])
    if "shippingCost" in match:
        d.setdefault("shipping_per_order", match["shippingCost"])
    return d


def evaluate(inp: TestInputs) -> dict:
    """Compute every metric + the verdict for one test. Pure function."""
    warnings: list[str] = []

    orders = max(int(inp.orders), 0)
    units = int(inp.units) if inp.units is not None else orders
    sessions = max(int(inp.sessions), 0)

    net_revenue = inp.revenue - inp.refunds

    # --- Variable costs ---------------------------------------------------
    cogs = inp.cogs_total if inp.cogs_total is not None else inp.cogs_per_unit * units
    shipping = (inp.shipping_total if inp.shipping_total is not None
                else inp.shipping_per_order * orders)
    if inp.processor_fees_total is not None:
        fees = inp.processor_fees_total
    else:
        # Fees are taken at charge time on GROSS revenue + per-txn fixed fee.
        fees = inp.revenue * (inp.processor_rate_pct / 100.0) + orders * inp.processor_fixed_fee

    variable_costs = cogs + shipping + fees

    # --- Contribution -----------------------------------------------------
    gross_contribution = net_revenue - variable_costs           # before ad spend
    net_contribution = gross_contribution - inp.ad_spend        # the bottom line
    cm_ratio = (gross_contribution / net_revenue) if net_revenue > 0 else None

    # --- Efficiency metrics ----------------------------------------------
    aov = (net_revenue / orders) if orders else None
    cvr = (orders / sessions) if sessions else None
    cac = (inp.ad_spend / orders) if orders else None
    roas = (net_revenue / inp.ad_spend) if inp.ad_spend > 0 else None
    breakeven_roas = (net_revenue / gross_contribution) if gross_contribution > 0 else None
    contribution_per_order = (gross_contribution / orders) if orders else None
    net_per_order = (net_contribution / orders) if orders else None
    # The most you can pay to acquire a customer and still break even.
    max_allowable_cac = contribution_per_order
    cac_headroom = (max_allowable_cac - cac) if (max_allowable_cac is not None and cac is not None) else None
    net_margin_pct = (net_contribution / net_revenue * 100.0) if net_revenue > 0 else None
    dispute_rate_pct = (inp.chargebacks / orders * 100.0) if orders else None
    refund_rate_pct = (inp.refunds / inp.revenue * 100.0) if inp.revenue > 0 else None

    # --- Verdict ----------------------------------------------------------
    # Primary verdict is binary and unambiguous: does the test make money
    # AFTER ad spend? Confidence + thinness are advisory flags layered on top.
    if cm_ratio is not None and cm_ratio <= 0:
        verdict = "KILL"
        reason = ("Unit economics are upside-down: the product loses money on "
                  "every sale before a single ad dollar. No ad efficiency can fix this.")
    elif net_contribution > 0:
        verdict = "NET-POSITIVE"
        reason = (f"Makes ${_money(net_contribution)} after ad spend "
                  f"(${_money(net_per_order)}/order).")
    else:
        verdict = "KILL"
        reason = (f"Loses ${_money(-net_contribution)} after ad spend. "
                  + (f"CAC ${_money(cac)} exceeds the ${_money(max_allowable_cac)} "
                     f"you can afford per order." if cac is not None and max_allowable_cac is not None
                     else "Ad cost outruns the contribution margin."))

    # Confidence: thin data -> the verdict is a hint, not a decision.
    low_confidence = orders < MIN_ORDERS_FOR_CONFIDENCE or inp.ad_spend < MIN_SPEND_FOR_CONFIDENCE
    if low_confidence:
        bits = []
        if orders < MIN_ORDERS_FOR_CONFIDENCE:
            bits.append(f"only {orders} order(s) (need >= {MIN_ORDERS_FOR_CONFIDENCE})")
        if inp.ad_spend < MIN_SPEND_FOR_CONFIDENCE:
            bits.append(f"only ${_money(inp.ad_spend)} spend (need >= ${MIN_SPEND_FOR_CONFIDENCE:.0f})")
        warnings.append("LOW CONFIDENCE: " + "; ".join(bits) + ". Keep testing before trusting this verdict.")

    # Thin margin: positive but fragile.
    thin = (verdict == "NET-POSITIVE" and net_margin_pct is not None
            and net_margin_pct < THIN_MARGIN_PCT)
    if thin:
        warnings.append(f"THIN MARGIN: net margin {_money(net_margin_pct)}% is under "
                        f"{THIN_MARGIN_PCT:.0f}%. Positive but fragile to CPM/refund swings.")

    # Processor / ad-account guardrails.
    if dispute_rate_pct is not None and dispute_rate_pct > DISPUTE_RATE_WARN_PCT:
        warnings.append(f"PROCESSOR RISK: dispute rate {_money(dispute_rate_pct)}% exceeds "
                        f"{DISPUTE_RATE_WARN_PCT:.0f}%. Chargebacks can freeze the processor.")
    if refund_rate_pct is not None and refund_rate_pct > REFUND_RATE_WARN_PCT:
        warnings.append(f"PROCESSOR RISK: refund rate {_money(refund_rate_pct)}% exceeds "
                        f"{REFUND_RATE_WARN_PCT:.0f}%. High refunds draw processor scrutiny.")

    return {
        "name": inp.name,
        "verdict": verdict,
        "verdict_reason": reason,
        "low_confidence": low_confidence,
        "thin_margin": thin,
        "warnings": warnings,
        "inputs": asdict(inp),
        "metrics": {
            "net_revenue": _money(net_revenue),
            "cogs": _money(cogs),
            "shipping": _money(shipping),
            "processor_fees": _money(fees),
            "variable_costs": _money(variable_costs),
            "gross_contribution": _money(gross_contribution),
            "net_contribution": _money(net_contribution),
            "contribution_margin_ratio": (round(cm_ratio, 4) if cm_ratio is not None else None),
            "net_margin_pct": (_money(net_margin_pct) if net_margin_pct is not None else None),
            "aov": (_money(aov) if aov is not None else None),
            "cvr": (round(cvr, 4) if cvr is not None else None),
            "cvr_pct": (_money(cvr * 100) if cvr is not None else None),
            "cac": (_money(cac) if cac is not None else None),
            "roas": (round(roas, 3) if roas is not None else None),
            "breakeven_roas": (round(breakeven_roas, 3) if breakeven_roas is not None else None),
            "contribution_per_order": (_money(contribution_per_order) if contribution_per_order is not None else None),
            "net_per_order": (_money(net_per_order) if net_per_order is not None else None),
            "max_allowable_cac": (_money(max_allowable_cac) if max_allowable_cac is not None else None),
            "cac_headroom": (_money(cac_headroom) if cac_headroom is not None else None),
            "dispute_rate_pct": (_money(dispute_rate_pct) if dispute_rate_pct is not None else None),
            "refund_rate_pct": (_money(refund_rate_pct) if refund_rate_pct is not None else None),
        },
    }


# ----------------------------------------------------------------------------
# Pretty terminal report
# ----------------------------------------------------------------------------
def _fmt(v, kind=""):
    if v is None:
        return "n/a"
    if kind == "$":
        return f"${v:,.2f}"
    if kind == "%":
        return f"{v:.2f}%"
    if kind == "x":
        return f"{v:.2f}x"
    return str(v)


def render(report: dict) -> str:
    m = report["metrics"]
    L = []
    bar = "=" * 60
    L.append(bar)
    L.append(f" PRODUCT TEST: {report['name']}")
    L.append(bar)
    flags = []
    if report["low_confidence"]:
        flags.append("LOW CONFIDENCE")
    if report["thin_margin"]:
        flags.append("THIN")
    flag_str = ("  [" + ", ".join(flags) + "]") if flags else ""
    L.append(f" VERDICT: {report['verdict']}{flag_str}")
    L.append(f"   {report['verdict_reason']}")
    L.append("")
    L.append(" THE BOTTOM LINE (after COGS + shipping + fees + ad spend)")
    L.append(f"   Net revenue ............. {_fmt(m['net_revenue'],'$')}")
    L.append(f"   - COGS .................. {_fmt(m['cogs'],'$')}")
    L.append(f"   - Shipping .............. {_fmt(m['shipping'],'$')}")
    L.append(f"   - Processor fees ........ {_fmt(m['processor_fees'],'$')}")
    L.append(f"   = Gross contribution .... {_fmt(m['gross_contribution'],'$')}   (before ad spend)")
    L.append(f"   - Ad spend .............. {_fmt(report['inputs']['ad_spend'],'$')}")
    L.append(f"   = NET CONTRIBUTION ...... {_fmt(m['net_contribution'],'$')}   <-- verdict is on this")
    L.append("")
    L.append(" EFFICIENCY")
    L.append(f"   AOV ............. {_fmt(m['aov'],'$')}      (avg order value)")
    L.append(f"   CVR ............. {_fmt(m['cvr_pct'],'%')}     (orders / sessions)")
    L.append(f"   CAC ............. {_fmt(m['cac'],'$')}      (ad cost / order)")
    L.append(f"   ROAS ............ {_fmt(m['roas'],'x')}      (revenue / ad spend)")
    L.append(f"   Break-even ROAS . {_fmt(m['breakeven_roas'],'x')}      (ROAS needed to not lose money)")
    L.append(f"   Net margin ...... {_fmt(m['net_margin_pct'],'%')}")
    L.append("")
    L.append(" CAC HEADROOM")
    L.append(f"   Contribution / order .. {_fmt(m['contribution_per_order'],'$')}")
    L.append(f"   Max CAC you can pay ... {_fmt(m['max_allowable_cac'],'$')}")
    L.append(f"   Headroom (max - CAC) .. {_fmt(m['cac_headroom'],'$')}")
    if report["warnings"]:
        L.append("")
        L.append(" WARNINGS")
        for w in report["warnings"]:
            L.append(f"   ! {w}")
    L.append(bar)
    return "\n".join(L)


EXAMPLE = {
    "name": "glow-serum-meta-test-01",
    "ad_spend": 300.0,
    "revenue": 540.0,
    "refunds": 30.0,
    "orders": 18,
    "units": 18,
    "sessions": 1200,
    "chargebacks": 0,
    "cogs_per_unit": 6.50,
    "shipping_per_order": 4.00,
    "processor_rate_pct": 2.9,
    "processor_fixed_fee": 0.30,
}


# ----------------------------------------------------------------------------
# Self-test: locks the formulas so a future edit can't silently change the math.
# ----------------------------------------------------------------------------
def self_test() -> int:
    failures = []

    def check(label, got, want, tol=0.01):
        if got is None or abs(got - want) > tol:
            failures.append(f"{label}: got {got}, want {want}")

    # Hand-computed expectations for EXAMPLE:
    #   net_revenue = 540 - 30 = 510
    #   cogs = 6.50 * 18 = 117
    #   shipping = 4 * 18 = 72
    #   fees = 540 * 0.029 + 18 * 0.30 = 15.66 + 5.40 = 21.06
    #   gross_contribution = 510 - 117 - 72 - 21.06 = 299.94
    #   net_contribution = 299.94 - 300 = -0.06  -> KILL (barely)
    #   aov = 510 / 18 = 28.333
    #   cac = 300 / 18 = 16.667
    #   roas = 510 / 300 = 1.70
    #   breakeven_roas = 510 / 299.94 = 1.7002
    #   contribution_per_order = 299.94 / 18 = 16.663
    r = evaluate(TestInputs.from_dict(EXAMPLE))
    m = r["metrics"]
    check("net_revenue", m["net_revenue"], 510.0)
    check("cogs", m["cogs"], 117.0)
    check("shipping", m["shipping"], 72.0)
    check("processor_fees", m["processor_fees"], 21.06)
    check("gross_contribution", m["gross_contribution"], 299.94)
    check("net_contribution", m["net_contribution"], -0.06)
    check("aov", m["aov"], 28.33)
    check("cac", m["cac"], 16.67)
    check("roas", m["roas"], 1.70)
    check("breakeven_roas", m["breakeven_roas"], 1.70)
    check("contribution_per_order", m["contribution_per_order"], 16.66)
    if r["verdict"] != "KILL":
        failures.append(f"verdict: got {r['verdict']}, want KILL")

    # A clear winner.
    win = evaluate(TestInputs.from_dict({
        "name": "winner", "ad_spend": 200.0, "revenue": 1000.0, "orders": 25,
        "sessions": 1000, "cogs_per_unit": 8.0, "shipping_per_order": 3.0,
    }))
    if win["verdict"] != "NET-POSITIVE":
        failures.append(f"winner verdict: got {win['verdict']}, want NET-POSITIVE")
    # fees = 1000*0.029 + 25*0.30 = 29 + 7.5 = 36.5; gross = 1000-200-75-36.5=688.5
    # net = 688.5 - 200 = 488.5
    check("winner net_contribution", win["metrics"]["net_contribution"], 488.5)

    # Upside-down unit economics -> KILL even with zero ad spend.
    bad = evaluate(TestInputs.from_dict({
        "name": "underwater", "ad_spend": 0.0, "revenue": 100.0, "orders": 5,
        "cogs_per_unit": 25.0, "shipping_per_order": 0.0,
    }))
    if bad["verdict"] != "KILL":
        failures.append(f"underwater verdict: got {bad['verdict']}, want KILL")

    # Low-confidence flag fires on thin data.
    tiny = evaluate(TestInputs.from_dict({
        "name": "tiny", "ad_spend": 10.0, "revenue": 60.0, "orders": 2,
        "sessions": 50, "cogs_per_unit": 5.0,
    }))
    if not tiny["low_confidence"]:
        failures.append("tiny: expected low_confidence=True")

    # Processor guardrail fires.
    disputed = evaluate(TestInputs.from_dict({
        "name": "disputed", "ad_spend": 100.0, "revenue": 1000.0, "orders": 50,
        "sessions": 2000, "cogs_per_unit": 5.0, "chargebacks": 1,
    }))
    if not any("PROCESSOR RISK" in w for w in disputed["warnings"]):
        failures.append("disputed: expected a PROCESSOR RISK warning (2% dispute rate)")

    # Product-slug reference pulls COGS/shipping from the store catalog.
    try:
        ref = TestInputs.from_dict({"product": "sample-product", "ad_spend": 100.0,
                                    "revenue": 500.0, "orders": 12, "sessions": 800})
        if ref.cogs_per_unit != 8.0 or ref.shipping_per_order != 4.5:
            failures.append(f"product ref: got cogs={ref.cogs_per_unit}, "
                            f"shipping={ref.shipping_per_order}, want 8.0 / 4.5")
    except Exception as e:  # catalog may be absent in some checkouts; don't hard-fail
        print(f"  (note: product-ref check skipped: {e})")

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print("  x", f)
        return 1
    print("SELF-TEST PASSED: all formula + verdict checks green.")
    return 0


def main(argv: list[str]) -> int:
    args = argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args[0] == "--self-test":
        return self_test()

    as_json = "--json" in args
    args = [a for a in args if a != "--json"]

    if args and args[0] == "--example":
        data = EXAMPLE
    elif args and args[0] == "-":
        data = json.load(sys.stdin)
    else:
        with open(args[0]) as fh:
            data = json.load(fh)

    report = evaluate(TestInputs.from_dict(data))
    print(json.dumps(report, indent=2) if as_json else render(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
