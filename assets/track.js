/* DRO-5 client tracking module — Meta Pixel + TikTok Pixel + GA4, UTM capture, dedup event IDs.
 *
 * Loaded on every page. Reads two build-injected globals:
 *   window.__TRACK__ = { meta, tiktok, ga4, capiEndpoint, currency, debug }  // store-level config
 *   window.__PAGE__  = { type, product }   // type: index|product|checkout|thankyou; product:{id,name,price,currency}
 *
 * Design goals:
 *  - Attribution accuracy over polish: every event carries a stable event_id so the browser
 *    pixel and the server-side Conversions API (api/capi) DEDUPLICATE into one event.
 *  - Ad-account safe: a pixel only initializes if its ID is present. No empty/broken pixels,
 *    no redirects, no cloaking. All third-party scripts load async.
 *  - Zero deps, no build step beyond copy. Degrades cleanly if a network/pixel is blocked.
 */
(function () {
  "use strict";
  var T = window.__TRACK__ || {};
  var PAGE = window.__PAGE__ || {};
  var CUR = (PAGE.product && PAGE.product.currency) || T.currency || "USD";
  var log = function () {
    if (T.debug && window.console) console.log.apply(console, ["[track]"].concat([].slice.call(arguments)));
  };

  // ---------- small utils ----------
  function uuid() {
    // RFC4122-ish; crypto if available, Math.random fallback (event_id only needs to be unique).
    if (window.crypto && crypto.getRandomValues) {
      var b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = [].map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); });
      return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") +
        "-" + h.slice(8, 10).join("") + "-" + h.slice(10, 16).join("");
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function store(k, v) {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { return null; }
  }
  function qs() { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(""); } }

  // ---------- UTM + click-id capture (first-touch persisted, last-touch updated) ----------
  // Canonical scheme — see TRACKING.md. Click ids (fbclid/ttclid/gclid) power CAPI match quality.
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var CLICK_KEYS = ["fbclid", "ttclid", "gclid"];
  function captureAttribution() {
    var p = qs(), now = Date.now(), last = {}, hasUtm = false;
    UTM_KEYS.concat(CLICK_KEYS).forEach(function (k) {
      var v = p.get(k);
      if (v) { last[k] = v; if (UTM_KEYS.indexOf(k) >= 0) hasUtm = true; }
    });
    if (hasUtm || Object.keys(last).length) {
      last.landing_page = location.pathname;
      last.ts = now;
      store("dro_attr_last", last);
      if (!store("dro_attr_first")) store("dro_attr_first", last); // first-touch, set once
      log("captured attribution", last);
    }
    return store("dro_attr_last") || store("dro_attr_first") || {};
  }
  var ATTR = captureAttribution();

  // fbp/fbc cookies (set by the Meta pixel) improve CAPI match rate — read defensively.
  function cookie(name) {
    var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : "";
  }

  // ---------- pixel initialization (each only if an ID is configured) ----------
  function initMeta(id) {
    if (!id) return;
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", id);
    log("meta pixel init", id);
  }
  function initTikTok(id) {
    if (!id) return;
    !(function (w, d, t) {
      w.TiktokAnalyticsObject = t; var ttq = (w[t] = w[t] || []);
      ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
      ttq.setAndDefer = function (e, n) { e[n] = function () { e.push([n].concat([].slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (e) { for (var n = ttq._i[e] || [], r = 0; r < ttq.methods.length; r++) ttq.setAndDefer(n, ttq.methods[r]); return n; };
      ttq.load = function (e, n) {
        var s = "https://analytics.tiktok.com/i18n/pixel/events.js"; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = s;
        ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {};
        var o = d.createElement("script"); o.type = "text/javascript"; o.async = !0; o.src = s + "?sdkid=" + e + "&lib=" + t;
        var a = d.getElementsByTagName("script")[0]; a.parentNode.insertBefore(o, a);
      };
      ttq.load(id);
    })(window, document, "ttq");
    log("tiktok pixel init", id);
  }
  function initGA4(id) {
    if (!id) return;
    var s = document.createElement("script"); s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", id, { send_page_view: false }); // we send page_view explicitly below
    log("ga4 init", id);
  }
  initMeta(T.meta); initTikTok(T.tiktok); initGA4(T.ga4);

  // ---------- unified event dispatch (browser pixels, all with shared eventID for dedup) ----------
  // Standard-event name map per platform.
  var NAMES = {
    PageView:         { meta: "PageView",         tiktok: "Pageview",        ga4: "page_view" },
    ViewContent:      { meta: "ViewContent",      tiktok: "ViewContent",     ga4: "view_item" },
    InitiateCheckout: { meta: "InitiateCheckout", tiktok: "InitiateCheckout",ga4: "begin_checkout" },
    Purchase:         { meta: "Purchase",         tiktok: "CompletePayment", ga4: "purchase" }
  };
  function track(name, params, opts) {
    params = params || {}; opts = opts || {};
    var eventId = opts.eventId || uuid();
    var n = NAMES[name] || { meta: name, tiktok: name, ga4: name };
    var value = params.value, contents = params.contents;
    // Meta
    if (window.fbq) {
      var mp = {};
      if (value != null) { mp.value = value; mp.currency = params.currency || CUR; }
      if (params.content_ids) { mp.content_ids = params.content_ids; mp.content_type = "product"; }
      if (params.content_name) mp.content_name = params.content_name;
      if (params.num_items) mp.num_items = params.num_items;
      window.fbq("track", n.meta, mp, { eventID: eventId });
    }
    // TikTok
    if (window.ttq) {
      var tp = {};
      if (value != null) { tp.value = value; tp.currency = params.currency || CUR; }
      if (contents) tp.contents = contents;
      try { window.ttq.track(n.tiktok, tp, { event_id: eventId }); } catch (e) { window.ttq.track(n.tiktok, tp); }
    }
    // GA4
    if (window.gtag) {
      var gp = { transaction_id: eventId };
      if (value != null) { gp.value = value; gp.currency = params.currency || CUR; }
      if (params.items) gp.items = params.items;
      window.gtag("event", n.ga4, gp);
    }
    log("event", name, eventId, params);
    return eventId;
  }
  // expose for inline page scripts (checkout handoff, thank-you)
  window.dro = { track: track, uuid: uuid, attr: function () { return ATTR; }, store: store, fbp: function () { return cookie("_fbp"); }, fbc: function () { return cookie("_fbc"); }, currency: CUR };

  // ---------- server-side relay (Conversions API) — same event_id => Meta/TikTok/GA4 dedup ----------
  // POSTs to api/capi (Vercel function). No-op if no endpoint configured (e.g. static-only host).
  window.dro.relay = function (eventName, params, eventId) {
    if (!T.capiEndpoint) { log("no capiEndpoint configured; browser pixel only"); return; }
    var payload = {
      event_name: (NAMES[eventName] && NAMES[eventName].meta) || eventName,
      event_id: eventId,
      event_source_url: location.href,
      action_source: "website",
      currency: params.currency || CUR,
      value: params.value,
      content_ids: params.content_ids,
      content_name: params.content_name,
      num_items: params.num_items,
      attribution: ATTR,
      fbp: cookie("_fbp"),
      fbc: cookie("_fbc") || (ATTR.fbclid ? "fb.1." + Date.now() + "." + ATTR.fbclid : ""),
      ttclid: ATTR.ttclid || "",
      gclid: ATTR.gclid || ""
    };
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon(T.capiEndpoint, new Blob([body], { type: "application/json" }));
      else fetch(T.capiEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true });
      log("relayed to CAPI", payload.event_name, eventId);
    } catch (e) { log("relay failed", e); }
  };

  // ---------- per-page automatic events ----------
  track("PageView");
  if (PAGE.type === "product" && PAGE.product) {
    track("ViewContent", {
      value: PAGE.product.price, currency: PAGE.product.currency,
      content_ids: [PAGE.product.id], content_name: PAGE.product.name,
      contents: [{ content_id: PAGE.product.id, quantity: 1, price: PAGE.product.price }],
      items: [{ item_id: PAGE.product.id, item_name: PAGE.product.name, price: PAGE.product.price, quantity: 1 }]
    });
  }
})();
