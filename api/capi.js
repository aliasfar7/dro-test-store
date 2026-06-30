// DRO-5 server-side Conversions API relay (Vercel serverless function).
//
// The browser thank-you page POSTs the purchase here with the SAME event_id it used for the pixel,
// so Meta/TikTok/GA4 deduplicate browser + server into one conversion (accurate CAC/ROAS).
//
// This file is only invoked on a function-capable host (Vercel). On a static-only host
// (GitHub Pages) the browser pixel still fires; there is just no server partner to dedup with.
// Credentials come from Vercel env vars (Project Settings -> Environment Variables) — never committed.
//
// Hardening: only POST, small JSON bodies, no reflection of secrets, permissive-but-bounded CORS so
// the static store (which may live on a different origin, e.g. GitHub Pages) can relay.

import { sendConversions } from "../scripts/lib/capi.mjs";

const ALLOW = (process.env.CAPI_ALLOW_ORIGIN || "*"); // set to your store origin in prod to lock down

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!body.event_name || !body.event_id) return res.status(400).json({ ok: false, error: "event_name and event_id required" });

    const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ev = {
      event_name: body.event_name,
      event_id: body.event_id,
      event_source_url: body.event_source_url,
      action_source: body.action_source || "website",
      value: body.value,
      currency: body.currency,
      content_ids: body.content_ids,
      content_name: body.content_name,
      num_items: body.num_items,
      email: body.email,
      fbp: body.fbp,
      fbc: body.fbc,
      ttclid: body.ttclid,
      gclid: body.gclid,
      ga_client_id: body.ga_client_id,
      client_ip: xff || req.socket?.remoteAddress,
      client_ua: req.headers["user-agent"],
      attribution: body.attribution,
    };

    const results = await sendConversions(ev);
    const ok = results.some((r) => r.ok);
    // 200 even on partial/no-config so the beacon never surfaces an error in the buyer's browser.
    return res.status(200).json({ ok, event_id: ev.event_id, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: "relay_error" });
  }
}
