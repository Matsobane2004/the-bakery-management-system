// Tests for bake/admin.js — the staff dashboard (orders + menu items).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, FakeElement, SAMPLE } from "../helpers/fake-browser.mjs";

const adminSignedIn = { token: "admin-token", "bakery-user": JSON.stringify(SAMPLE.admin) };
const ORDERS = [
  { id: 12, user_id: 3, total: 135, status: "pending", notes: "No <nuts>", delivery_address: null, created_at: "2026-10-08T10:00:00",
    items: [{ id: 1, product_id: 16, product: { id: 16, name: "Caramel Frappe" }, quantity: 3, unit_price: 45 }] },
  { id: 11, user_id: 4, total: 45, status: "delivered", notes: null, delivery_address: "7 Park Ave", created_at: "2026-10-07T10:00:00",
    items: [{ id: 2, product_id: 99, product: null, quantity: 1, unit_price: 45 }] },
];
const ALL_PRODUCTS = [
  { id: 1, name: "White Loaf", description: "Soft white bread", price: 18, category_id: 1, is_available: false },
  ...SAMPLE.products,
];

function adminPage({ routes = {}, storage = adminSignedIn, confirm, offline = false } = {}) {
  const server = fakeServer({
    "GET /auth/sso": SAMPLE.admin,
    "GET /orders": ORDERS,
    "GET /categories": [{ id: 1, name: "Breads" }, ...SAMPLE.categories],
    "GET /products?available_only=false": ALL_PRODUCTS,
    ...routes,
  });
  server.offline = offline;
  return loadPage(["bake/api.js", "bake/admin.js"], {
    server,
    storage,
    confirm,
    url: "https://example.test/admin.html",
    setup: (document) => {
      // Starting state written in admin.html
      document.getElementById("orders-filter").value = "all";
      document.getElementById("admin-dashboard").hidden = true;
      document.getElementById("admin-denied").hidden = true;
    },
  });
}
const rowsOf = (html) => html.split("<tr>").slice(1);
const clickRow = (page, action, id) => page.$("inventory-body").fire("click", {
  target: new FakeElement({ dataset: { action, id: String(id) }, matches: ["button[data-action]"] }),
});
const changeStatus = (page, id, status) => page.$("orders-body").fire("change", {
  target: Object.assign(new FakeElement({ dataset: { id: String(id) }, matches: [".status-select"] }), { value: status }),
});

describe("who can open the dashboard", () => {
  test("signed out: goes to sign in, then comes back", async () => {
    const page = adminPage({ storage: {} });
    await settle();
    assert.equal(page.location.replaced, "account.html?next=admin.html");
  });

  test("a customer account is turned away, with a way to switch accounts", async () => {
    const page = adminPage({ routes: { "GET /auth/sso": SAMPLE.customer }, storage: { token: "customer-token" } });
    await settle();
    assert.equal(page.$("admin-denied").hidden, false);
    assert.equal(page.$("admin-denied-title").textContent, "Staff only");
    assert.match(page.$("admin-denied-text").textContent, /Thabo Nkosi/);
    assert.equal(page.$("admin-dashboard").hidden, true, "the dashboard is never shown");
    assert.equal(page.server.calls.some((c) => c.path === "/orders"), false, "orders are not even requested");

    page.$("admin-denied-action").onclick();
    assert.equal(page.localStorage.getItem("token"), null);
    assert.equal(page.location.href, "account.html?next=admin.html");
  });

  test("server down: says so, with a Try again button", async () => {
    const page = adminPage({ offline: true });
    await settle();
    assert.equal(page.$("admin-denied-title").textContent, "Can't reach the bakery server");
    page.$("admin-denied-action").onclick();
    assert.equal(page.location.reloaded, true);
  });

  test("an admin sees the dashboard", async () => {
    const page = adminPage();
    await settle();
    assert.equal(page.$("admin-dashboard").hidden, false);
    assert.equal(page.$("admin-user-name").textContent, "Admin User");
  });
});

describe("orders", () => {
  test("lists every order with a pending count", async () => {
    const page = adminPage();
    await settle();
    assert.equal(page.$("orders-count").textContent, "2 orders · 1 pending");
    const rows = rowsOf(page.$("orders-body").innerHTML);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /#12/);
    assert.match(rows[0], /3 × Caramel Frappe/);
    assert.match(rows[0], /Note: No &lt;nuts&gt;/);
    assert.match(rows[0], /<option value="pending" selected>Pending<\/option>/);
    assert.match(rows[1], /1 × Product #99/);
  });

  test("the status filter shows only matching orders", async () => {
    const page = adminPage();
    await settle();
    page.$("orders-filter").value = "delivered";
    page.$("orders-filter").fire("change");
    const rows = rowsOf(page.$("orders-body").innerHTML);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /#11/);
    page.$("orders-filter").value = "ready";
    page.$("orders-filter").fire("change");
    assert.equal(page.$("orders-empty").hidden, false);
  });

  test("changing a status saves it on the server", async () => {
    const page = adminPage({ routes: { "PUT /orders/12/status": { ...ORDERS[0], status: "confirmed" } } });
    await settle();
    changeStatus(page, 12, "confirmed");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.method === "PUT").body, { status: "confirmed" });
    assert.equal(page.$("orders-message").textContent, "Order #12 is now Confirmed.");
    assert.equal(page.$("orders-count").textContent, "2 orders · 0 pending");
  });

  test("if saving a status fails, the old status is shown again", async () => {
    const page = adminPage({ routes: { "PUT /orders/12/status": reply(400, { detail: "Invalid status" }) } });
    await settle();
    changeStatus(page, 12, "confirmed");
    await settle();
    assert.equal(page.$("orders-message").textContent, "Invalid status");
    assert.match(page.$("orders-body").innerHTML, /<option value="pending" selected>/);
  });

  test("a sign-in that expires mid-way goes to sign in again", async () => {
    const page = adminPage({ routes: { "PUT /orders/12/status": reply(401, { detail: "Invalid or expired token" }) } });
    await settle();
    changeStatus(page, 12, "ready");
    await settle();
    assert.equal(page.location.replaced, "account.html?next=admin.html");
  });
});

describe("menu items", () => {
  test("lists all items, items on sale first, with their category names", async () => {
    const page = adminPage();
    await settle();
    assert.equal(page.$("inventory-count").textContent, "4 items · 3 on the menu");
    const rows = rowsOf(page.$("inventory-body").innerHTML);
    assert.deepEqual(rows.map((r) => r.match(/<strong>(.*?)<\/strong>/)[1]), ["Chocolate Cake", "Caramel Frappe", "Oreo Frappe", "White Loaf"]);
    assert.match(rows[3], /category-label">Breads</);
    assert.match(rows[3], /hidden-status/);
  });

  test("search and category filter narrow the list", async () => {
    const page = adminPage();
    await settle();
    page.$("search-items").value = "FRAPPE";
    page.$("search-items").fire("input");
    assert.equal(rowsOf(page.$("inventory-body").innerHTML).length, 2);
    page.$("search-items").value = "";
    page.$("filter-category").value = "2";
    page.$("filter-category").fire("change");
    assert.equal(rowsOf(page.$("inventory-body").innerHTML).length, 1);
  });

  test("adding an item needs a name and a price above R0", async () => {
    const page = adminPage();
    await settle();
    page.$("item-name").value = "Muffin";
    page.$("item-price").value = "0";
    page.$("item-form").fire("submit");
    await settle();
    assert.equal(page.$("form-message").textContent, "Enter a name and a price above R0.");
    assert.equal(page.server.calls.some((c) => c.method === "POST"), false);
  });

  test("adding an item sends it to the server with the price rounded to cents", async () => {
    const page = adminPage({ routes: { "POST /products": reply(201, { id: 30 }) } });
    await settle();
    page.$("item-name").value = " Blueberry Muffin ";
    page.$("item-category").value = "2";
    page.$("item-price").value = "22.499";
    page.$("item-description").value = "";
    page.$("item-form").fire("submit");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.method === "POST").body,
      { name: "Blueberry Muffin", category_id: 2, price: 22.5, description: null });
    assert.equal(page.$("form-message").textContent, "Menu item added.");
  });

  test("Edit fills the form, and saving updates that item", async () => {
    const page = adminPage({ routes: { "PUT /products/17": { ...SAMPLE.products[2], price: 50 } } });
    await settle();
    clickRow(page, "edit", 17);
    assert.equal(page.$("item-name").value, "Oreo Frappe");
    assert.equal(page.$("item-price").value, 54);
    assert.equal(page.$("save-item").textContent, "Save changes");
    page.$("item-price").value = "50";
    page.$("item-form").fire("submit");
    await settle();
    const put = page.server.calls.find((c) => c.method === "PUT");
    assert.equal(put.path, "/products/17");
    assert.equal(put.body.price, 50);
    assert.equal(page.$("save-item").textContent, "Add item", "the form goes back to adding");
  });

  test("Hidden/Visible switches whether the item is on the menu", async () => {
    const page = adminPage({ routes: { "PUT /products/16": { ...SAMPLE.products[1], is_available: false } } });
    await settle();
    clickRow(page, "toggle", 16);
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.method === "PUT").body, { is_available: false });
    assert.equal(page.$("inventory-message").textContent, "Caramel Frappe is hidden from the menu.");
  });

  test("Delete asks first, and does nothing if the answer is no", async () => {
    const page = adminPage({ confirm: () => false });
    await settle();
    clickRow(page, "delete", 16);
    await settle();
    assert.equal(page.server.calls.some((c) => c.method === "DELETE"), false);
  });

  test("Delete removes the item when confirmed", async () => {
    const page = adminPage({ confirm: () => true, routes: { "DELETE /products/16": reply(204, undefined) } });
    await settle();
    clickRow(page, "delete", 16);
    await settle();
    assert.equal(page.server.calls.find((c) => c.method === "DELETE").path, "/products/16");
    assert.equal(page.$("inventory-message").textContent, "Caramel Frappe was deleted.");
  });
});
