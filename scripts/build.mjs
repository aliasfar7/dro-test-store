// Static test-store generator.
// Source of truth: data/products.json. Output: public/ (deployable static site).
// Add a product = add one entry to products.json, then `npm run build`.
//
// BASE_PATH env var: URL prefix the site is served under (e.g. "/dro-test-store"
// for GitHub Pages project sites). Default "" for root hosting (Vercel/Netlify/custom domain).
// All internal links use explicit ".html" so the site is portable across hosts with no
// clean-URL rewrites required.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, ""); // no trailing slash
const data = JSON.parse(readFileSync(join(ROOT, "data", "products.json"), "utf8"));
const { store } = data;
const products = data.products.filter((p) => p.active !== false);
const sym = store.currencySymbol || "$";
const money = (n) => `${sym}${Number(n).toFixed(2)}`;
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const url = (p) => `${BASE}${p}`; // prefix an absolute site path

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
  const gallery = (p.gallery && p.gallery.length ? p.gallery : [p.image])
    .map((g) => `<img class="thumb" src="${esc(g)}" alt="${esc(p.name)}" loading="lazy" />`)
    .join("");
  const benefits = (p.benefits || []).map((b) => `<li>${esc(b)}</li>`).join("");
  const checkoutHref = url(`/checkout.html?p=${encodeURIComponent(p.slug)}`);
  const body = `
  <a class="back" href="${url("/")}">← All test products</a>
  <section class="pdp">
    <div class="media">
      <img class="hero" src="${esc(p.image)}" alt="${esc(p.name)}" />
      <div class="gallery">${gallery}</div>
    </div>
    <div class="info">
      <h1>${esc(p.name)}</h1>
      <p class="tagline">${esc(p.tagline || "")}</p>
      <p class="price">
        <strong>${money(p.price)}</strong>
        ${hasSale ? `<span class="strike">${money(p.compareAtPrice)}</span>` : ""}
      </p>
      <ul class="benefits">${benefits}</ul>
      <a class="cta" href="${checkoutHref}" data-slug="${esc(p.slug)}">Buy now</a>
      <p class="ship muted">${esc(p.shipping || "")}</p>
      <div class="desc"><p>${esc(p.description || "")}</p></div>
    </div>
  </section>`;
  return layout(`${p.name} — ${store.name}`, body);
}

// --- Index ---
const cards = products
  .map(
    (p) => `<a class="card" href="${url(`/p/${p.slug}.html`)}">
    <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />
    <div class="card-body"><h3>${esc(p.name)}</h3><p class="price">${money(p.price)}</p></div>
  </a>`
  )
  .join("");
const indexBody = `
  <header class="hero-head"><h1>${esc(store.name)}</h1>
  <p class="muted">Live one-product test pages. ${products.length} active.</p></header>
  <section class="grid">${cards || "<p>No active products. Add one in data/products.json.</p>"}</section>`;
writeFileSync(join(OUT, "index.html"), layout(store.name, indexBody));

// --- Product pages ---
for (const p of products) {
  writeFileSync(join(OUT, "p", `${p.slug}.html`), productPage(p));
}

// --- Checkout page (order summary + email + hosted-checkout handoff) ---
const checkoutBody = `
  <a class="back" href="${url("/")}">← Back to store</a>
  <h1>Checkout</h1>
  <section id="summary" class="checkout"></section>`;
const checkoutHead = `<script src="${url("/assets/catalog.js")}"></script>
<script>
window.__BASE__=${JSON.stringify(BASE)};
window.addEventListener("DOMContentLoaded",function(){
  var sym=(window.STORE&&window.STORE.sym)||"$";
  var slug=new URLSearchParams(location.search).get("p");
  var item=window.CATALOG&&window.CATALOG[slug];
  var el=document.getElementById("summary");
  if(!item){el.innerHTML='<p class="muted">Product not found. <a href="'+window.__BASE__+'/">Return to store</a>.</p>';return;}
  var price=sym+Number(item.price).toFixed(2);
  el.innerHTML='<div class="order"><img src="'+item.image+'" alt="" /><div><h3>'+item.name+'</h3><p class="price">'+price+'</p></div></div>'+
    '<label class="fld">Email<input id="email" type="email" placeholder="you@example.com" required /></label>'+
    '<div class="total"><span>Total</span><strong>'+price+'</strong></div>'+
    '<button id="pay" class="cta">Continue to secure payment</button><p id="note" class="muted"></p>';
  document.getElementById("pay").addEventListener("click",function(){
    var email=document.getElementById("email").value.trim();
    var note=document.getElementById("note");
    if(!email||email.indexOf("@")<0){note.textContent="Enter a valid email to continue.";return;}
    if(item.checkoutUrl){
      var u=item.checkoutUrl;
      u+=(u.indexOf("?")<0?"?":"&")+"prefilled_email="+encodeURIComponent(email);
      location.href=u;
    }else{
      note.innerHTML="Payment processor not connected yet (pending DRO-4). Add a hosted checkout URL to this product in data/products.json to go live.";
    }
  });
});
</script>`;
writeFileSync(join(OUT, "checkout.html"), layout(`Checkout — ${store.name}`, checkoutBody, checkoutHead));

// --- Styles ---
writeFileSync(join(OUT, "assets", "styles.css"), readFileSync(join(ROOT, "src", "styles.css"), "utf8"));

// --- Catalog for client-side checkout ---
const catalog = Object.fromEntries(
  products.map((p) => [
    p.slug,
    { name: p.name, price: p.price, image: p.image, checkoutUrl: p.checkoutUrl || "" },
  ])
);
writeFileSync(
  join(OUT, "assets", "catalog.js"),
  `window.CATALOG=${JSON.stringify(catalog)};window.STORE=${JSON.stringify({ name: store.name, sym })};`
);

console.log(`Built ${products.length} product page(s) -> ${OUT} (BASE_PATH="${BASE || "/"}")`);
