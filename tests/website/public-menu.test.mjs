// Tests for bake/public-menu.js — the home page menu from GET /categories + GET /products.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, FakeElement, SAMPLE } from "../helpers/fake-browser.mjs";

const BACKUP = "<article>backup menu written in index.html</article>";

function menuPage(server, storage = {}) {
  const grid = new FakeElement();
  grid.innerHTML = BACKUP;
  const page = loadPage(["bake/api.js", "bake/cart.js", "bake/public-menu.js"], {
    server,
    storage,
    setup: (document) => { document.selectors["#menu .menu-grid"] = grid; },
  });
  return { page, grid };
}
const liveMenu = () => fakeServer({ "GET /categories": SAMPLE.categories, "GET /products": SAMPLE.products });

test("shows one card per category that has products, in the server's order", async () => {
  const { grid } = menuPage(liveMenu());
  await settle();
  const headings = [...grid.innerHTML.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["Cakes", "Frappes"], "Beverages has no products, so it gets no card");
  assert.equal(grid.getAttribute("aria-busy"), null);
});

test("each item has its price and an Add button with the product's id, name and price", async () => {
  const { grid } = menuPage(liveMenu());
  await settle();
  assert.match(grid.innerHTML, /<span class="item-name">Oreo Frappe<\/span><span class="item-actions"><span class="price">R54<\/span>/);
  assert.match(grid.innerHTML, /data-id="17" data-name="Oreo Frappe" data-price="54"/);
});

test("each category gets its own picture, with a default for new categories", async () => {
  const server = fakeServer({
    "GET /categories": [...SAMPLE.categories, { id: 12, name: "Pies" }],
    "GET /products": [...SAMPLE.products, { id: 30, name: "Chicken Pie", price: 65, category_id: 12, is_available: true }],
  });
  const { grid } = menuPage(server);
  await settle();
  assert.match(grid.innerHTML, /src="images\/frappe.png" alt="Frappes"/);
  assert.match(grid.innerHTML, /src="images\/about-interior.png" alt="Pies"/);
});

test("names from the server are shown as text, never as HTML", async () => {
  const server = fakeServer({
    "GET /categories": [{ id: 2, name: "Cakes & <i>Bakes</i>" }],
    "GET /products": [{ id: 4, name: 'Cake "Deluxe" <b>', price: 45, category_id: 2, is_available: true }],
  });
  const { grid } = menuPage(server);
  await settle();
  assert.match(grid.innerHTML, /<h3>Cakes &amp; &lt;i&gt;Bakes&lt;\/i&gt;<\/h3>/);
  assert.match(grid.innerHTML, /data-name="Cake &quot;Deluxe&quot; &lt;b&gt;"/);
  assert.doesNotMatch(grid.innerHTML, /<b>|<i>/);
});

test("if the server can't be reached, the backup menu stays", async () => {
  const server = liveMenu();
  server.offline = true;
  const { grid } = menuPage(server);
  await settle();
  assert.equal(grid.innerHTML, BACKUP);
  assert.equal(grid.getAttribute("aria-busy"), null, "the loading state is always cleared");
});

test("if the server has errors, the backup menu stays", async () => {
  const { grid } = menuPage(fakeServer({ "GET /categories": SAMPLE.categories, "GET /products": reply(500, undefined) }));
  await settle();
  assert.equal(grid.innerHTML, BACKUP);
});

test("an empty menu says it is being updated", async () => {
  const { grid } = menuPage(fakeServer({ "GET /categories": SAMPLE.categories, "GET /products": [] }));
  await settle();
  assert.match(grid.innerHTML, /The menu is being updated/);
});

test("the cart is told about the live menu, so backup items become orderable", async () => {
  const cart = [{ id: null, name: "Oreo Frappe", price: 50, qty: 1 }];
  const { page } = menuPage(liveMenu(), { "bakery-cart": JSON.stringify(cart) });
  await settle();
  assert.deepEqual(JSON.parse(page.localStorage.getItem("bakery-cart")), [{ id: 17, name: "Oreo Frappe", price: 54, qty: 1 }]);
  assert.equal(page.$("cart-total").textContent, "R54");
});
