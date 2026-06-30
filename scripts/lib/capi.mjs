// DRO-5 server-side Conversions API sender — Meta CAPI + TikTok Events API + GA4 Measurement Protocol.
//
// Shared by api/capi.js (Vercel function, browser-relayed) and scripts/verify-tracking.mjs (CLI proof).
// Dependency-free: Node 18+ global fetch only — nothing to npm-install, nothing to commit/update.
//
// DEDUP CONTRACT: the caller passes the SAME `event_id` that the browser pixel used for the same
// event. Meta dedups on (event_name, event_id); TikTok on event_id; GA4 on transaction_id. That is
// the entire point of this file — one purchase = one counted conversion, not two.
//
// Credentials are read from the environment ONLY (never logged, never committed). See .env.example.

import { createHash } from "node:crypto";

const sha256 = (s) => (s ? createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex") : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null));

/**
 * @param {object} ev  normalized event:
 *   { event_name, event_id, event_source_url, action_source, value, currency,
 *     content_ids[], content_name, num_items, email, fbp, fbc, ttclid, gclid,
 *     client_ip, client_ua, attribution{} }
 * @param {object} env process.env (or a subset). Recognized:
 *   META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE
 *   TIKTOK_PIXEL_ID, TIKTOK_CAPI_TOKEN, TIKTOK_TEST_EVENT_CODE
 *   GA4_MEASUREMENT_ID, GA4_API_SECRET
 * @returns {Promise<{platform,ok,status,detail}[]>} one result per configured platform.
 */
export async function sendConversions(ev, env = process.env) {
  const now = Math.floor(Date.now() / 1000);
  const tasks = [];
  if (env.META_PIXEL_ID && env.META_CAPI_TOKEN) tasks.push(sendMeta(ev, env, now));
  if (env.TIKTOK_PIXEL_ID && env.TIKTOK_CAPI_TOKEN) tasks.push(sendTikTok(ev, env, now));
  if (env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) tasks.push(sendGA4(ev, env));
  if (!tasks.length) return [{ platform: "none", ok: false, status: 0, detail: "no CAPI credentials configured in environment" }];
  return Promise.all(tasks);
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json; try { json = await res.json(); } catch { json = {}; }
  return { ok: res.ok, status: res.status, json };
}

async function sendMeta(ev, env, now) {
  const user_data = clean({
    em: ev.email ? [sha256(ev.email)] : undefined,
    fbp: ev.fbp,
    fbc: ev.fbc,
    client_ip_address: ev.client_ip,
    client_user_agent: ev.client_ua,
  });
  const custom_data = clean({
    currency: ev.currency || "USD",
    value: ev.value != null ? Number(ev.value) : undefined,
    content_ids: ev.content_ids,
    content_type: ev.content_ids ? "product" : undefined,
    content_name: ev.content_name,
    num_items: ev.num_items,
  });
  const payload = clean({
    data: [clean({
      event_name: ev.event_name,
      event_time: now,
      event_id: ev.event_id, // <-- dedup key vs browser pixel eventID
      event_source_url: ev.event_source_url,
      action_source: ev.action_source || "website",
      user_data,
      custom_data,
    })],
    test_event_code: env.META_TEST_EVENT_CODE || undefined,
  });
  const url = `https://graph.facebook.com/v20.0/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`;
  const r = await postJSON(url, payload);
  return {
    platform: "meta",
    ok: r.ok && r.json && r.json.events_received >= 1,
    status: r.status,
    detail: r.ok ? `events_received=${r.json.events_received} fbtrace_id=${r.json.fbtrace_id || ""}` : (r.json.error?.message || JSON.stringify(r.json)),
  };
}

async function sendTikTok(ev, env, now) {
  const payload = clean({
    event_source: "web",
    event_source_id: env.TIKTOK_PIXEL_ID,
    test_event_code: env.TIKTOK_TEST_EVENT_CODE || undefined,
    data: [clean({
      event: ev.event_name === "Purchase" ? "CompletePayment" : ev.event_name,
      event_time: now,
      event_id: ev.event_id, // <-- dedup key
      user: clean({ email: ev.email ? sha256(ev.email) : undefined, ttclid: ev.ttclid, ip: ev.client_ip, user_agent: ev.client_ua }),
      properties: clean({
        currency: ev.currency || "USD",
        value: ev.value != null ? Number(ev.value) : undefined,
        contents: ev.content_ids ? ev.content_ids.map((id) => ({ content_id: id, quantity: 1, price: ev.value })) : undefined,
        content_type: ev.content_ids ? "product" : undefined,
      }),
      page: clean({ url: ev.event_source_url }),
    })],
  });
  const r = await postJSON("https://business-api.tiktok.com/open_api/v1.3/event/track/", payload);
  return {
    platform: "tiktok",
    ok: r.ok && r.json && r.json.code === 0,
    status: r.status,
    detail: r.json?.code === 0 ? `code=0 request_id=${r.json.request_id || ""}` : (r.json?.message || JSON.stringify(r.json)),
  };
}

async function sendGA4(ev, env) {
  const payload = {
    client_id: ev.ga_client_id || `${Math.floor(Math.random() * 1e10)}.${Math.floor(Date.now() / 1000)}`,
    events: [clean({
      name: ev.event_name === "Purchase" ? "purchase" : ev.event_name,
      params: clean({
        transaction_id: ev.event_id, // <-- GA4 dedups purchases on transaction_id
        currency: ev.currency || "USD",
        value: ev.value != null ? Number(ev.value) : undefined,
        items: ev.content_ids ? ev.content_ids.map((id) => ({ item_id: id, item_name: ev.content_name, price: ev.value, quantity: 1 })) : undefined,
      }),
    })],
  };
  const dbg = env.GA4_DEBUG ? "/debug" : "";
  const url = `https://www.google-analytics.com${dbg}/mp/collect?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`;
  const r = await postJSON(url, payload);
  // GA4 MP returns 204 with no body on success; /debug returns validationMessages.
  const valid = !env.GA4_DEBUG ? r.status === 204 : (r.json.validationMessages || []).length === 0;
  return { platform: "ga4", ok: r.status === 204 || (r.ok && valid), status: r.status, detail: env.GA4_DEBUG ? JSON.stringify(r.json.validationMessages || []) : "sent (MP returns 204)" };
}
