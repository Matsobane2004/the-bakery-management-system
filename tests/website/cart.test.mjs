// Tests for bake/cart.js — the cart drawer, WhatsApp ordering and POST /orders.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, FakeElement, SAMPLE } from "../helpers/fake-browser.mjs";

const signedIn = { token: "good-token", "bakery-user": JSON.stringify(SAMPLE.customer) };
const frappe = { id: 16, name: "Caramel Frappe", price: 45 };
const cake = { id: 4, name: "Chocolate Cake", price: 45 };

function cartPage({ server = fakeServer({ "GET /auth/sso": SAMPLE.customer }), cart, storage = {}, url } = {}) {
  if (cart) storage = { ...storage, "bakery-cart": JSON.stringify(cart) };
  return loadPage(["bake/api.js", "bake/cart.js"], { server, storage, url });
}
// Click an "Add" button like the ones on the menu (id is missing on the backup menu)
function clickAdd(page, { id, name, price }) {
  const dataset = { name, price: String(price), ...(id ? { id: String(id) } : {}) };
  page.document.fire("click", { target: new FakeElement({ dataset, matches: [".btn-add"] }) });
}
function clickQty(page, index, delta) {
  const button = new FakeElement({ dataset: { index: String(index), delta: String(delta) }, matches: [".qty-btn"] });
  page.$("cart-items").fire("click", { target: button });
}
const menuLoaded = (page, products) => page.document.dispatchEvent({ type: "bakery:menu-loaded", detail: products });
const savedCart = (page) => JSON.parse(page.localStorage.getItem("bakery-cart") || "[]");

describe("adding and changing items", () => {
  test("adding an item updates the badge, total and saved cart", () => {
    const page = cartPage();
    clickAdd(page, frappe);
    assert.equal(page.$("cart-count").textContent, 1);
    assert.equal(page.$("cart-total").textContent, "R45");
    assert.match(page.$("cart-items").html, /Caramel Frappe/);
    assert.deepEqual(savedCart(page), [{ ...frappe, qty: 1 }]);
  });

  test("adding the same item again raises its quantity instead of adding a row", () => {
    const page = cartPage();
    clickAdd(page, frappe);
    clickAdd(page, frappe);
    clickAdd(page, cake);
    assert.deepEqual(savedCart(page).map((i) => [i.name, i.qty]), [["Caramel Frappe", 2], ["Chocolate Cake", 1]]);
    assert.equal(page.$("cart-count").textContent, 3);
    assert.equal(page.$("cart-total").textContent, "R135");
  });

  test("the minus button removes an item when it reaches zero", () => {
    const page = cartPage({ cart: [{ ...frappe, qty: 2 }] });
    clickQty(page, 0, -1);
    assert.equal(savedCart(page)[0].qty, 1);
    clickQty(page, 0, -1);
    assert.deepEqual(savedCart(page), []);
    assert.equal(page.$("cart-total").textContent, "R0");
    assert.equal(page.$("cart-whatsapp").hidden, true);
  });

  test("the cart is still there after a page reload", () => {
    const first = cartPage();
    clickAdd(first, frappe);
    const second = cartPage({ storage: { "bakery-cart": first.localStorage.getItem("bakery-cart") } });
    assert.equal(second.$("cart-total").textContent, "R45");
  });

  test("a damaged saved cart starts empty instead of crashing", () => {
    const page = loadPage(["bake/api.js", "bake/cart.js"], { storage: { "bakery-cart": "{oops" } });
    assert.equal(page.$("cart-count").textContent, 0);
  });

  test("item names are shown as text, never as HTML", () => {
    const page = cartPage({ cart: [{ id: 5, name: "Cake <b>big</b>", price: 10, qty: 1 }] });
    assert.match(page.$("cart-items").html, /Cake &lt;b&gt;big&lt;\/b&gt;/);
    assert.doesNotMatch(page.$("cart-items").html, /<b>big/);
  });
});

describe("WhatsApp ordering", () => {
  test("the WhatsApp link has every item, the total, the address and the note", () => {
    const page = cartPage();
    clickAdd(page, frappe);
    clickAdd(page, frappe);
    clickAdd(page, cake);
    page.$("cart-address").value = "12 Main St";
    page.$("cart-notes").value = "No sugar";
    page.$("cart-address").fire("input");
    const href = page.$("cart-whatsapp").href;
    assert.ok(href.startsWith("https://wa.me/27813586602?text="));
    const text = decodeURIComponent(href.split("?text=")[1]);
    assert.equal(text, "Hi! I'd like to order:\n- 2 x Caramel Frappe (R90)\n- 1 x Chocolate Cake (R45)\nTotal: R135\nDeliver to: 12 Main St\nNote: No sugar");
  });
});

describe("backup menu (server offline) and the live menu", () => {
  test("items from the backup menu can only be ordered on WhatsApp", () => {
    const page = cartPage({ storage: signedIn });
    clickAdd(page, { name: "Caramel Frappe", price: 45 }); // backup menu: no id
    assert.match(page.$("cart-notice-text").textContent, /unavailable right now/);
    assert.equal(page.$("cart-checkout").hidden, true);
    assert.equal(page.$("cart-whatsapp").hidden, false);
  });

  test("when the live menu loads, backup items are matched to real products and prices", () => {
    const page = cartPage({ cart: [{ id: null, name: "caramel frappe", price: 40, qty: 2 }] });
    menuLoaded(page, SAMPLE.products);
    assert.deepEqual(savedCart(page), [{ id: 16, name: "Caramel Frappe", price: 45, qty: 2 }]);
    assert.equal(page.$("cart-total").textContent, "R90");
    assert.equal(page.$("cart-checkout").hidden, false);
  });

  test("BUG: an item that was taken off the menu is removed, and the customer is told", () => {
    const page = cartPage({ cart: [{ ...frappe, qty: 1 }, { id: 99, name: "Pumpkin Pie", price: 30, qty: 1 }] });
    menuLoaded(page, SAMPLE.products); // the server no longer sells product 99
    assert.deepEqual(savedCart(page).map((i) => i.name), ["Caramel Frappe"]);
    assert.match(page.$("cart-message").textContent, /Pumpkin Pie is no longer on the menu/);
    assert.equal(page.$("cart-checkout").hidden, false, "the rest of the cart can still be ordered");
  });

  test("an empty menu from the server doesn't wipe the cart", () => {
    const page = cartPage({ cart: [{ ...frappe, qty: 1 }] });
    menuLoaded(page, []);
    assert.equal(savedCart(page).length, 1);
  });
});

describe("placing an order", () => {
  test("signed out: the button says so and leads to sign-in, then back to the cart", () => {
    const page = cartPage({ cart: [{ ...frappe, qty: 1 }], url: "https://example.test/baker.html" });
    assert.equal(page.$("cart-checkout").textContent, "Sign in to order");
    page.$("cart-checkout").fire("click");
    assert.equal(page.location.href, "account.html?next=baker.html%23cart");
  });

  test("signed out on the home page address ( / ) returns to index.html", () => {
    const page = cartPage({ cart: [{ ...frappe, qty: 1 }], url: "https://example.test/" });
    page.$("cart-checkout").fire("click");
    assert.equal(page.location.href, "account.html?next=index.html%23cart");
  });

  test("signed in: sends the order, empties the cart and says thank you", async () => {
    const order = { id: 31, user_id: 3, total: 135, status: "pending", items: [], created_at: "2026-10-09T10:00:00" };
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "POST /orders": reply(201, order) });
    const page = cartPage({ server, storage: signedIn, cart: [{ ...frappe, qty: 2 }, { ...cake, qty: 1 }] });
    await settle();
    assert.equal(page.$("cart-checkout").textContent, "Place order");
    page.$("cart-address").value = "  12 Main St  ";
    page.$("cart-checkout").fire("click");
    await settle();

    const sent = server.calls.find((c) => c.method === "POST");
    assert.deepEqual(sent.body, {
      items: [{ product_id: 16, quantity: 2 }, { product_id: 4, quantity: 1 }],
      delivery_address: "12 Main St",
      notes: null,
    });
    assert.deepEqual(savedCart(page), []);
    assert.match(page.$("cart-items").html, /Order #31 is in/);
    assert.match(page.$("cart-items").html, /Total R135/);
    assert.equal(page.$("cart-address").value, "");
  });

  test("clicking Place order twice only sends one order", async () => {
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "POST /orders": reply(201, { id: 1, total: 45, status: "pending" }) });
    const page = cartPage({ server, storage: signedIn, cart: [{ ...frappe, qty: 1 }] });
    await settle();
    page.$("cart-checkout").fire("click");
    page.$("cart-checkout").fire("click");
    await settle();
    assert.equal(server.calls.filter((c) => c.method === "POST").length, 1);
  });

  test("an expired sign-in at checkout keeps the cart and asks to sign in again", async () => {
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "POST /orders": reply(401, { detail: "Invalid or expired token" }) });
    const page = cartPage({ server, storage: signedIn, cart: [{ ...frappe, qty: 1 }] });
    await settle();
    page.$("cart-checkout").fire("click");
    await settle();
    assert.equal(page.$("cart-message").textContent, "Your sign-in has expired. Please sign in again.");
    assert.equal(savedCart(page).length, 1);
    assert.equal(page.$("cart-checkout").textContent, "Sign in to order");
  });

  test("BUG: an item that sold out since it was added is named in the error", async () => {
    // e.g. on baker.html, which has no menu, so the cart never hears about menu changes
    const server = fakeServer({
      "GET /auth/sso": SAMPLE.customer,
      "POST /orders": reply(404, { detail: "Product 99 not found or unavailable" }),
    });
    const page = cartPage({ server, storage: signedIn, url: "https://example.test/baker.html", cart: [{ ...frappe, qty: 1 }, { id: 99, name: "Pumpkin Pie", price: 30, qty: 1 }] });
    await settle();
    page.$("cart-checkout").fire("click");
    await settle();
    assert.match(page.$("cart-message").textContent, /Pumpkin Pie is no longer available/);
    assert.equal(savedCart(page).length, 2, "nothing is removed without the customer knowing");
  });

  test("the server being down at checkout shows a clear message and keeps the cart", async () => {
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer });
    const page = cartPage({ server, storage: signedIn, cart: [{ ...frappe, qty: 1 }] });
    await settle();
    server.offline = true;
    page.$("cart-checkout").fire("click");
    await settle();
    assert.match(page.$("cart-message").textContent, /Can't reach the bakery server/);
    assert.equal(savedCart(page).length, 1);
  });
});

describe("opening and closing the drawer", () => {
  test("opens with the cart button and closes with Escape", () => {
    const page = cartPage();
    page.$("cart-open").fire("click");
    assert.equal(page.$("cart-drawer").classList.contains("open"), true);
    page.document.fire("keydown", { key: "Escape" });
    assert.equal(page.$("cart-drawer").classList.contains("open"), false);
    assert.equal(page.$("cart-overlay").hidden, true);
  });

  test("opens by itself when coming back from signing in (#cart)", () => {
    const page = cartPage({ url: "https://example.test/index.html#cart" });
    assert.equal(page.$("cart-drawer").classList.contains("open"), true);
  });
});
