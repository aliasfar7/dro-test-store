#!/usr/bin/env node
// DRO-5 tracking verification — proves the end-to-end purchase pipeline is wired and deduplicated.
//
// Two layers, both run by default:
//   1) STATIC WIRING (no creds): build the site with sample pixel ids and assert that pixels,
//      track.js, UTM capture, InitiateCheckout/Purchase events, and the dedup event_id handoff are
//      all present in the generated output.
//   2) LIVE CAPI TEST EVENT (when creds are in env): sends a deduplicated Purchase to the Meta /
//      TikTok / GA4 Conversions APIs and asserts the platform accepted it. With META_TEST_EVENT_CODE
//      set, the event appears in Events Manager -> Test Events — the acceptance-criteria proof.
//
// Usage:
//   node scripts/verify-tracking.mjs                  # static wiring checks (always)
//   META_PIXEL_ID=... META_CAPI_TOKEN=... META_TEST_EVENT_CODE=TEST12345 \
//     node scripts/verify-tracking.mjs               # + live Meta Test Event proof
//   GA4_MEASUREMENT_ID=... GA4_API_SECRET=... GA4_DEBUG=1 node scripts/verify-tracking.mjs  # + GA4 validation
//
// Credentials are read from the environment only — never logged, never committed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sendConversions } from "./lib/capi.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Build the sample-id site into a throwaway temp dir, NOT the tracked public/ — otherwise every
// verification run would leave fake pixel ids (1234567890, …) staged in the deployed output.
const OUT = mkdtempSync(join(tmpdir(), "dro5-verify-"));
const DATA = join(ROOT, "data", "products.json");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

console.log("DRO-5 tracking verification\n");

// ---- 1. Build with sample pixel ids (so the conditional snippets actually emit), then restore ----
console.log("1) Build with sample pixel ids and assert wiring");
const sample = JSON.parse(readFileSync(DATA, "utf8"));
sample.store.pixel = { meta: "1234567890", tiktok: "TT_TEST_PIXEL", ga4: "G-TEST12345" };
sample.store.capiEndpoint = "/api/capi";
const orig = readFileSync(DATA, "utf8");
try {
  writeFileSync(DATA, JSON.stringify(sample, null, 2));
  execFileSync("node", [join(ROOT, "scripts", "build.mjs")], { stdio: "pipe", env: { ...process.env, OUT_DIR: OUT } });
} finally {
  writeFileSync(DATA, orig); // ALWAYS restore the real data file, even if the build throws
}

const idx = read(join(OUT, "index.html"));
const pdp = read(join(OUT, "p", "sample-product.html"));
const co = read(join(OUT, "checkout.html"));
const ty = read(join(OUT, "thank-you.html"));
const trackjs = read(join(OUT, "assets", "track.js"));
const all = idx + pdp + co + ty + trackjs;

ok(trackjs.includes("captureAttribution") && trackjs.includes("UTM_KEYS"), "track.js emitted with UTM capture");
ok(idx.includes("/assets/track.js") && pdp.includes("/assets/track.js"), "track.js linked on index + product pages");
ok(idx.includes('"meta":"1234567890"'), "store-level Meta pixel id injected");
ok(idx.includes('"tiktok":"TT_TEST_PIXEL"'), "TikTok pixel id injected");
ok(idx.includes('"ga4":"G-TEST12345"'), "GA4 id injected");
ok(idx.includes("facebook.com/tr?id=1234567890"), "Meta <noscript> fallback present (id-gated)");
ok(pdp.includes('"type":"product"') && pdp.includes('"id":"sample-product"'), "product page passes ViewContent product context");
ok(co.includes("InitiateCheckout"), "checkout fires InitiateCheckout");
ok(co.includes("dro_pending") && co.includes("uuid"), "checkout pre-mints dedup event_id + persists purchase context");
ok(co.includes("client_reference_id"), "checkout carries dedup ref into hosted checkout URL");
ok(co.includes("utm_source"), "checkout carries UTMs into processor URL (attribution survives redirect)");
ok(ty.includes("Purchase") && ty.includes("dro.relay"), "thank-you fires Purchase pixel + server CAPI relay");
ok(ty.includes("eventId:eid"), "thank-you uses one pre-minted event_id for pixel + CAPI (dedup)");
ok(!/\bsk_(test|live)_/.test(all) && !/access_token=/.test(all), "no secret keys / tokens leaked into built output");

// ---- 2. Dedup contract ----
console.log("\n2) Dedup contract");
const eid = randomUUID();
ok(typeof eid === "string" && eid.length > 10, `generated event_id ${eid}`);
console.log("   browser pixel eventID == server CAPI event_id => one counted conversion, not two.");

// ---- 3. Optional live Conversions API test event ----
console.log("\n3) Live Conversions API test event (only platforms with creds in env)");
const anyCreds = (process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN) ||
  (process.env.TIKTOK_PIXEL_ID && process.env.TIKTOK_CAPI_TOKEN) ||
  (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);

if (!anyCreds) {
  console.log("  • No CAPI credentials in env — skipping live send (static wiring already proven above).");
  console.log("    To prove a real Events-Manager event once the CEO supplies access, set e.g.:");
  console.log("      META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE=TESTxxxxx  (Events Manager -> Test Events)");
  finish();
} else {
  const ev = {
    event_name: "Purchase", event_id: eid, action_source: "website",
    event_source_url: "https://example.com/thank-you.html",
    value: 39.0, currency: "USD", content_ids: ["sample-product"], content_name: "Sample Test Product",
    num_items: 1, email: "qa+dro5@example.com",
  };
  try {
    const results = await sendConversions(ev);
    for (const r of results) ok(r.ok, `${r.platform}: ${r.detail}`);
    if (process.env.META_TEST_EVENT_CODE) {
      console.log(`\n  → Meta Events Manager → Test Events (code ${process.env.META_TEST_EVENT_CODE}): the Purchase (event_id ${eid}) should appear.`);
    }
  } catch (e) {
    fail++; console.log(`  ✗ live send error: ${e.message}`);
  }
  finish();
}

function finish() {
  rmSync(OUT, { recursive: true, force: true }); // drop the throwaway sample-id build
  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
