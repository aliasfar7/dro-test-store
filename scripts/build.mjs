// Static test-store generator.
// Source of truth: data/products.json. Output: public/ (deployable static site).
// Add a product = add one entry to products.json, then `npm run build`.
//
// BASE_PATH env var: URL prefix the site is served under (e.g. "/dro-test-store"
// for GitHub Pages project sites). Default "" for root hosting (Vercel/Netlify/custom domain).
// All internal links use explicit ".html" so the site is portable across hosts with no
// clean-URL rewrites required.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT_DIR || join(ROOT, "public"); // verify builds redirect this to a temp dir
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, ""); // no trailing slash
const data = JSON.parse(readFileSync(join(ROOT, "data", "products.json"), "utf8"));
const { store } = data;
const products = data.products.filter((p) => p.active !== false);
const sym = store.currencySymbol || "$";
const money = (n) => `${sym}${Number(n).toFixed(2)}`;
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const url = (p) => `${BASE}${p}`; // prefix an absolute site path
// Image src helper: BASE-prefix local paths ("/assets/..."), pass external URLs through untouched.
const img = (p) => (typeof p === "string" && p.startsWith("/")) ? url(p) : p;

// --- Tracking config (DRO-5) -------------------------------------------------
// Store-level pixel/CAPI config; a product may override any pixel id. Empty ids => that pixel is
// simply not initialized (no broken/empty pixels — ad-account safe). capiEndpoint enables the
// server-side Conversions API relay (api/capi); leave "" on static-only hosts (browser pixel only).
const storePixel = store.pixel || {};
const capiEndpoint = store.capiEndpoint || "";
const currency = store.currency || "USD";
function trackHead(page, product) {
  // Per-field inheritance: a product overrides a pixel id only when it provides a non-empty value.
  // An empty product.pixel field means "inherit the store id", NOT "disable" — otherwise a product
  // carrying `pixel:{meta:""}` would silently strip the store pixel off its own page (no ViewContent).
  const pp = (product && product.pixel) || {};
  const cfg = {
    meta: pp.meta || storePixel.meta || "",
    tiktok: pp.tiktok || storePixel.tiktok || "",
    ga4: pp.ga4 || storePixel.ga4 || "",
    capiEndpoint, currency, debug: false,
  };
  const pg = { type: page };
  if (product) pg.product = { id: product.sku || product.slug, name: product.name, price: product.price, currency };
  // Meta <noscript> pixel fallback — only when a Meta id is configured.
  const noscript = cfg.meta
    ? `<noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${esc(cfg.meta)}&ev=PageView&noscript=1" /></noscript>`
    : "";
  return `<script>window.__TRACK__=${JSON.stringify(cfg)};window.__PAGE__=${JSON.stringify(pg)};</script>
<script src="${url("/assets/track.js")}" defer></script>${noscript}`;
}

// Reset generated output dir (keep nothing stale).
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "p"), { recursive: true });
mkdirSync(join(OUT, "assets"), { recursive: true });

const layout = (title, body, head = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="${url("/assets/styles.css")}" />
${head}
</head>
<body>
<main class="wrap">${body}</main>
<footer class="foot">
  <p>${esc(store.name)} · Test environment · Questions: ${esc(store.supportEmail)}</p>
  <p class="muted">This is a product-testing store. Pages may be added or removed at any time.</p>
</footer>
</body>
</html>`;

// --- Product page ---
function productPage(p) {
  const hasSale = p.compareAtPrice && p.compareAtPrice > p.price;
  const savePct = hasSale ? Math.round((1 - p.price / p.compareAtPrice) * 100) : 0;
  const gallery = (p.gallery && p.gallery.length ? p.gallery : [p.image])
    .map((g) => `<img class="thumb" src="${esc(img(g))}" alt="${esc(p.name)}" loading="lazy" />`)
    .join("");
  const benefits = (p.benefits || []).map((b) => `<li>${esc(b)}</li>`).join("");
  // Fun, optional, data-driven flourishes. Absent fields simply render nothing.
  const chips = (p.tags || [])
    .map((t, i) => `<span class="chip${i === 0 ? " hot" : ""}">${esc(t)}</span>`)
    .join("");
  const swatches = (p.colors || [])
    .map((c) => `<span class="dot" style="background:${esc(c)}"></span>`)
    .join("");
  const trust = (p.trust || [])
    .map((t) => `<span>${esc(t)}</span>`)
    .join("");
  const checkoutHref = url(`/checkout.html?p=${encodeURIComponent(p.slug)}`);
  const body = `
  <a class="back" href="${url("/")}">← All test products</a>
  <section class="pdp">
    <div class="media">
      <img class="hero" src="${esc(img(p.image))}" alt="${esc(p.name)}" />
      <div class="gallery">${gallery}</div>
    </div>
    <div class="info">
      <h1>${esc(p.name)}</h1>
      <p class="tagline">${esc(p.tagline || "")}</p>
      ${chips ? `<div class="badges">${chips}</div>` : ""}
      ${swatches ? `<div class="swatches">${swatches}</div>` : ""}
      <p class="price">
        <strong>${money(p.price)}</strong>
        ${hasSale ? `<span class="strike">${money(p.compareAtPrice)}</span><span class="save">-${savePct}%</span>` : ""}
      </p>
      <ul class="benefits">${benefits}</ul>
      <a class="cta" href="${checkoutHref}" data-slug="${esc(p.slug)}">Buy now →</a>
      <p class="ship muted">${esc(p.shipping || "")}</p>
      ${trust ? `<div class="trust">${trust}</div>` : ""}
      <div class="desc"><p>${esc(p.description || "")}</p></div>
    </div>
  </section>`;
  return layout(`${p.name} — ${store.name}`, body, trackHead("product", p));
}

// --- Index ---
const cards = products
  .map(
    (p) => `<a class="card" href="${url(`/p/${p.slug}.html`)}">
    <img src="${esc(img(p.image))}" alt="${esc(p.name)}" loading="lazy" />
    <div class="card-body"><h3>${esc(p.name)}</h3><p class="price">${money(p.price)}</p></div>
  </a>`
  )
  .join("");
const indexBody = `
  <header class="hero-head"><h1>${esc(store.name)}</h1>
  <p class="muted">Live one-product test pages. ${products.length} active.</p></header>
  <section class="grid">${cards || "<p>No active products. Add one in data/products.json.</p>"}</section>`;
writeFileSync(join(OUT, "index.html"), layout(store.name, indexBody, trackHead("index")));

// --- Product pages ---
for (const p of products) {
  writeFileSync(join(OUT, "p", `${p.slug}.html`), productPage(p));
}

// --- Checkout page (order summary + email + hosted-checkout handoff) ---
const checkoutBody = `
  <a class="back" href="${url("/")}">← Back to store</a>
  <h1>Checkout</h1>
  <section id="summary" class="checkout"></section>`;
const checkoutHead = trackHead("checkout") + `
<script src="${url("/assets/catalog.js")}"></script>
<script>
window.__BASE__=${JSON.stringify(BASE)};
window.addEventListener("DOMContentLoaded",function(){
  var sym=(window.STORE&&window.STORE.sym)||"$";
  var cur=(window.STORE&&window.STORE.currency)||"USD";
  var slug=new URLSearchParams(location.search).get("p");
  var item=window.CATALOG&&window.CATALOG[slug];
  var el=document.getElementById("summary");
  if(!item){el.innerHTML='<p class="muted">Product not found. <a href="'+window.__BASE__+'/">Return to store</a>.</p>';return;}
  var price=sym+Number(item.price).toFixed(2);
  el.innerHTML='<div class="order"><img src="'+item.image+'" alt="" /><div><h3>'+item.name+'</h3><p class="price">'+price+'</p></div></div>'+
    '<label class="fld">Email<input id="email" type="email" placeholder="you@example.com" required /></label>'+
    '<div class="total"><span>Total</span><strong>'+price+'</strong></div>'+
    '<button id="pay" class="cta">Continue to secure payment</button><p id="note" class="muted"></p>';
  // InitiateCheckout — fired once on reaching the checkout step.
  if(window.dro)window.dro.track("InitiateCheckout",{value:item.price,currency:cur,content_ids:[slug],content_name:item.name,
    contents:[{content_id:slug,quantity:1,price:item.price}],items:[{item_id:slug,item_name:item.name,price:item.price,quantity:1}]});
  document.getElementById("pay").addEventListener("click",function(){
    var email=document.getElementById("email").value.trim();
    var note=document.getElementById("note");
    if(!email||email.indexOf("@")<0){note.textContent="Enter a valid email to continue.";return;}
    if(item.checkoutUrl){
      // Pre-mint the Purchase event_id so the thank-you pixel and server CAPI dedup to one event.
      var eid=window.dro?window.dro.uuid():String(Date.now());
      var attr=window.dro?window.dro.attr():{};
      window.dro&&window.dro.store("dro_pending",{event_id:eid,slug:slug,name:item.name,value:item.price,currency:cur,email:email,attribution:attr,ts:Date.now()});
      var u=item.checkoutUrl;
      u+=(u.indexOf("?")<0?"?":"&")+"prefilled_email="+encodeURIComponent(email);
      u+="&client_reference_id="+encodeURIComponent(eid); // ties the order back for server-side dedup (DRO-4 webhook)
      // Carry attribution into the processor's URL so the order is always source-attributable.
      ["utm_source","utm_medium","utm_campaign","utm_content","utm_term"].forEach(function(k){if(attr[k])u+="&"+k+"="+encodeURIComponent(attr[k]);});
      location.href=u;
    }else{
      note.innerHTML="Payment processor not connected yet (pending DRO-4). Add a hosted checkout URL to this product in data/products.json to go live.";
    }
  });
});
</script>`;
writeFileSync(join(OUT, "checkout.html"), layout(`Checkout — ${store.name}`, checkoutBody, checkoutHead));

// --- Thank-you page (post-payment redirect target) ---------------------------
// Set the hosted checkout's "after payment" redirect to <site>/thank-you.html. This page fires the
// Purchase pixel + relays the same event_id to the server CAPI (dedup). Order value/currency/email
// come from the dro_pending context stored at checkout handoff; ?value=&currency= can override.
const thankyouBody = `
  <section class="checkout">
    <h1>Thank you — order confirmed</h1>
    <p class="muted">Your payment was received. A confirmation email is on its way.</p>
    <p id="ty-detail" class="muted"></p>
    <a class="cta" href="${url("/")}">Continue browsing</a>
  </section>`;
const thankyouHead = trackHead("thankyou") + `
<script>
window.addEventListener("DOMContentLoaded",function(){
  if(!window.dro)return;
  var p=window.dro.store("dro_pending")||{};
  var q=new URLSearchParams(location.search);
  var value=q.get("value")!=null?Number(q.get("value")):p.value;
  var currency=q.get("currency")||p.currency||window.dro.currency;
  var eid=p.event_id||q.get("client_reference_id")||window.dro.uuid();
  // Guard against double-fire on refresh (dedup also protects, but keep it clean).
  if(window.dro.store("dro_fired_"+eid)){return;}
  var params={value:value,currency:currency,content_ids:p.slug?[p.slug]:undefined,content_name:p.name,num_items:1};
  window.dro.track("Purchase",params,{eventId:eid});      // browser pixels
  var relay=Object.assign({},params,{currency:currency}); if(p.email)relay.email=p.email;
  window.dro.relay("Purchase",relay,eid);                  // server CAPI (same event_id)
  window.dro.store("dro_fired_"+eid,true);
  window.dro.store("dro_pending",null);
  var d=document.getElementById("ty-detail");
  if(d&&value!=null)d.textContent="Order total: "+currency+" "+Number(value).toFixed(2);
});
</script>`;
writeFileSync(join(OUT, "thank-you.html"), layout(`Thank you — ${store.name}`, thankyouBody, thankyouHead));

// --- Styles ---
writeFileSync(join(OUT, "assets", "styles.css"), readFileSync(join(ROOT, "src", "styles.css"), "utf8"));

// --- Tracking module (DRO-5) ---
writeFileSync(join(OUT, "assets", "track.js"), readFileSync(join(ROOT, "src", "track.js"), "utf8"));

// --- Image assets (product imagery lives in src/img, served from /assets/img) ---
const imgSrc = join(ROOT, "src", "img");
if (existsSync(imgSrc)) cpSync(imgSrc, join(OUT, "assets", "img"), { recursive: true });

// --- Catalog for client-side checkout ---
const catalog = Object.fromEntries(
  products.map((p) => [
    p.slug,
    { name: p.name, price: p.price, image: img(p.image), checkoutUrl: p.checkoutUrl || "", currency },
  ])
);
writeFileSync(
  join(OUT, "assets", "catalog.js"),
  `window.CATALOG=${JSON.stringify(catalog)};window.STORE=${JSON.stringify({ name: store.name, sym, currency })};`
);

console.log(`Built ${products.length} product page(s) -> ${OUT} (BASE_PATH="${BASE || "/"}")`);
