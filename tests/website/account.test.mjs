// Tests for bake/account.js — sign in / create account, SSO, profile and order history.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, SAMPLE } from "../helpers/fake-browser.mjs";

const signedIn = { token: "good-token", "bakery-user": JSON.stringify(SAMPLE.customer) };
const ORDERS = [
  {
    id: 12, user_id: 3, total: 135, status: "preparing", delivery_address: "12 Main St", notes: "Extra <cream>", created_at: "2026-10-08T10:00:00",
    items: [
      { id: 1, product_id: 16, product: { id: 16, name: "Caramel Frappe" }, quantity: 2, unit_price: 45 },
      { id: 2, product_id: 99, product: null, quantity: 1, unit_price: 45 }, // product deleted since
    ],
  },
  { id: 11, user_id: 3, total: 45, status: "cancelled", delivery_address: null, notes: null, created_at: "2026-10-07T10:00:00", items: [] },
];

function accountPage({ routes = {}, storage = {}, url = "https://example.test/account.html", offline = false } = {}) {
  const server = fakeServer({ "GET /orders": ORDERS, ...routes });
  server.offline = offline;
  return loadPage(["bake/api.js", "bake/account.js"], { server, storage, url });
}
const visibleView = (page) => ["account-loading", "offline-view", "auth-view", "account-view"].filter((id) => !page.$(id).hidden);

describe("opening the page (SSO)", () => {
  test("signed out: shows the sign-in form", async () => {
    const page = accountPage();
    await settle();
    assert.deepEqual(visibleView(page), ["auth-view"]);
  });

  test("signed in: skips the form and shows the profile and orders", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer }, storage: signedIn });
    await settle();
    assert.deepEqual(visibleView(page), ["account-view"]);
    assert.equal(page.$("account-name").textContent, "Thabo");
    assert.match(page.$("account-details").textContent, /^thabo@gmail.com · 0821234567 · Member since 0?1 Oct 2026$/);
    assert.equal(page.$("admin-link").hidden, true);
    assert.equal(page.$("orders-title").textContent, "My orders");
  });

  test("an admin also gets the link to the staff dashboard", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.admin }, storage: { token: "admin-token" } });
    await settle();
    assert.equal(page.$("admin-link").hidden, false);
    assert.equal(page.$("orders-title").textContent, "All orders");
  });

  test("an expired sign-in shows the form and forgets the old token", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": reply(401, { detail: "Invalid or expired token" }) }, storage: signedIn });
    await settle();
    assert.deepEqual(visibleView(page), ["auth-view"]);
    assert.equal(page.localStorage.getItem("token"), null);
  });

  test("server down: says so, and Try again works once it's back", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer }, storage: signedIn, offline: true });
    await settle();
    assert.deepEqual(visibleView(page), ["offline-view"]);
    assert.match(page.$("offline-message").textContent, /Can't reach the bakery server/);

    page.server.offline = false;
    page.$("offline-retry").fire("click");
    await settle();
    assert.deepEqual(visibleView(page), ["account-view"]);
  });

  test("#register opens on the Create account tab", async () => {
    const page = accountPage({ url: "https://example.test/account.html#register" });
    assert.equal(page.$("register-form").hidden, false);
    assert.equal(page.$("login-form").hidden, true);
    assert.equal(page.$("tab-register").getAttribute("aria-selected"), "true");
  });
});

describe("order history", () => {
  async function ordersHtml() {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer }, storage: signedIn });
    await settle();
    return { page, html: page.$("order-list").innerHTML };
  }

  test("shows each order's number, status, total and items", async () => {
    const { html } = await ordersHtml();
    assert.match(html, /Order #12/);
    assert.match(html, /status-badge status-preparing">Preparing</);
    assert.match(html, /Total R135/);
    assert.match(html, /2 × Caramel Frappe <span class="muted">R90<\/span>/);
  });

  test("progress steps are ticked up to the current status", async () => {
    const { html } = await ordersHtml();
    const steps = [...html.split("Order #11")[0].matchAll(/<li class="(done)?">(\w+)<\/li>/g)].map((m) => m[2] + (m[1] ? "✓" : ""));
    assert.deepEqual(steps, ["Pending✓", "Confirmed✓", "Preparing✓", "Ready", "Delivered"]);
  });

  test("a cancelled order has no progress steps", async () => {
    const { html } = await ordersHtml();
    assert.doesNotMatch(html.split("Order #11")[1], /order-progress/);
  });

  test("an item whose product was deleted still shows (by number)", async () => {
    const { html } = await ordersHtml();
    assert.match(html, /1 × Product #99/);
  });

  test("the customer's address and note are shown as text", async () => {
    const { html } = await ordersHtml();
    assert.match(html, /Deliver to: 12 Main St/);
    assert.match(html, /Note: Extra &lt;cream&gt;/);
  });

  test("no orders yet: links to the menu", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer, "GET /orders": [] }, storage: signedIn });
    await settle();
    assert.equal(page.$("orders-status").hidden, false);
    assert.match(page.$("orders-status").innerHTML, /No orders yet/);
  });

  test("a sign-in that expires while on the page goes back to the form", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer, "GET /orders": reply(401, { detail: "Invalid or expired token" }) }, storage: signedIn });
    await settle();
    assert.deepEqual(visibleView(page), ["auth-view"]);
    assert.equal(page.$("login-error").textContent, "Your sign-in has expired. Please sign in again.");
  });
});

describe("signing in and creating an account", () => {
  test("signing in sends the trimmed email and shows the account", async () => {
    const page = accountPage({ routes: { "POST /auth/login": { access_token: "t", token_type: "bearer", user: SAMPLE.customer } } });
    await settle();
    page.$("login-email").value = "  thabo@gmail.com ";
    page.$("login-password").value = "Pass@1234";
    page.$("login-form").fire("submit");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.path === "/auth/login").body, { email: "thabo@gmail.com", password: "Pass@1234" });
    assert.deepEqual(visibleView(page), ["account-view"]);
    assert.equal(page.$("login-form").wasReset, true, "the password is cleared from the form");
  });

  test("a wrong password shows the server's message and re-enables the button", async () => {
    const page = accountPage({ routes: { "POST /auth/login": reply(401, { detail: "Invalid email or password" }) } });
    await settle();
    const button = page.$("login-form").querySelector('button[type="submit"]');
    button.textContent = "Sign in";
    page.$("login-email").value = "thabo@gmail.com";
    page.$("login-password").value = "wrong";
    page.$("login-form").fire("submit");
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Signing in…");
    await settle();
    assert.equal(page.$("login-error").textContent, "Invalid email or password");
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Sign in");
  });

  test("an incomplete form is not sent", async () => {
    const page = accountPage();
    await settle();
    const form = page.$("login-form");
    form.valid = false;
    form.querySelector(":invalid").validationMessage = "Please fill in this field.";
    form.fire("submit");
    await settle();
    assert.equal(page.$("login-error").textContent, "Please fill in this field.");
    assert.equal(page.server.calls.length, 0);
  });

  test("creating an account sends name, email, password, and no phone if it was left empty", async () => {
    const page = accountPage({ routes: { "POST /auth/register": reply(201, { access_token: "t", token_type: "bearer", user: SAMPLE.customer }) } });
    await settle();
    page.$("register-name").value = " Thabo Nkosi ";
    page.$("register-email").value = "thabo@gmail.com";
    page.$("register-phone").value = "   ";
    page.$("register-password").value = "Pass@1234";
    page.$("register-form").fire("submit");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.path === "/auth/register").body,
      { name: "Thabo Nkosi", email: "thabo@gmail.com", phone: null, password: "Pass@1234" });
    assert.equal(page.localStorage.getItem("token"), "t");
  });

  test("an email that is already registered shows the server's message", async () => {
    const page = accountPage({ routes: { "POST /auth/register": reply(400, { detail: "Email already registered" }) } });
    await settle();
    page.$("register-form").fire("submit");
    await settle();
    assert.equal(page.$("register-error").textContent, "Email already registered");
  });

  test("logging out forgets the sign-in and shows the form", async () => {
    const page = accountPage({ routes: { "GET /auth/sso": SAMPLE.customer }, storage: signedIn });
    await settle();
    page.$("logout-btn").fire("click");
    assert.equal(page.localStorage.getItem("token"), null);
    assert.deepEqual(visibleView(page), ["auth-view"]);
    assert.equal(page.$("order-list").innerHTML, "");
  });
});

describe("going back after signing in (?next=)", () => {
  const signedInAt = (next) => accountPage({
    routes: { "GET /auth/sso": SAMPLE.customer },
    storage: signedIn,
    url: "https://example.test/account.html?next=" + encodeURIComponent(next),
  });

  test("returns to the page the visitor came from, with the cart open", async () => {
    const page = signedInAt("index.html#cart");
    await settle();
    assert.equal(page.location.replaced, "index.html#cart");
  });

  for (const next of ["https://example.com/index.html", "//example.com/index.html", "../admin.html"]) {
    test(`ignores addresses that are not a page on this site: ${next}`, async () => {
      const page = signedInAt(next);
      await settle();
      assert.equal(page.location.replaced, null);
      assert.deepEqual(visibleView(page), ["account-view"]);
    });
  }
});
