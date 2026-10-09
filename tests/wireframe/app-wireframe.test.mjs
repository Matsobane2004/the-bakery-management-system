// Tests for bakery-app/app-wireframe.js — the app wireframe connected to the backend API.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, FakeElement, SAMPLE } from "../helpers/fake-browser.mjs";

const SCREENS = ["splash", "login", "register", "home", "order", "settings"];
const signedIn = { token: "good-token" };

function appPage({ routes = {}, storage = {}, url = "https://example.test/app-wireframe.html", offline = false } = {}) {
  const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "GET /products": SAMPLE.products, "GET /orders": [], ...routes });
  server.offline = offline;
  const orderLink = new FakeElement();
  const page = loadPage(["bakery-app/app-wireframe.js"], {
    server,
    storage,
    url,
    setup: (document) => {
      document.selectorLists[".screen"] = SCREENS.map((id) => document.getElementById(id));
      document.selectorLists[".order-link"] = [orderLink];
      const prefs = document.getElementById("preferences-form");
      prefs.notifications = { checked: true };
      prefs.offers = { checked: false };
      prefs.theme = { value: "Dark gold" };
    },
  });
  page.orderLink = orderLink;
  return page;
}
const activeScreen = (page) => SCREENS.filter((id) => page.$(id).classList.contains("active")).join(",");
const savedCart = (page) => JSON.parse(page.localStorage.getItem("app-cart") || "[]");
const clickAdd = (page, id) => page.$("menu-list").fire("click", {
  target: new FakeElement({ dataset: { id: String(id) }, matches: ["button[data-id]"] }),
});

describe("small helpers", () => {
  const page = appPage();
  test("rand() formats prices in rand", () => {
    assert.equal(page.run("rand(45)"), "R45");
    assert.equal(page.run("rand(12.5)"), "R12.50");
  });
  test("esc() shows special characters as text", () => {
    assert.equal(page.run(`esc('<b>"A" & B</b>')`), "&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;");
    assert.equal(page.run("esc(null)"), "");
  });
  test("when() reads server times as UTC", () => {
    assert.equal(page.run(`when("2026-10-08T10:00:00")`), page.run(`when("2026-10-08T10:00:00Z")`));
  });
});

describe("starting the app (SSO)", () => {
  test("no saved sign-in: shows the login screen without asking the server", async () => {
    const page = appPage();
    await settle();
    assert.equal(activeScreen(page), "login");
    assert.equal(page.server.calls.length, 0);
  });

  test("a valid saved sign-in skips login and opens Home with the menu", async () => {
    const page = appPage({ storage: signedIn });
    await settle();
    assert.equal(activeScreen(page), "home");
    assert.match(page.$("greeting").textContent, /^Good (morning|afternoon|evening), Thabo$/);
    assert.equal(page.$("profile-email").textContent, "thabo@gmail.com");
    assert.match(page.$("menu-list").innerHTML, /Caramel Frappe/);
    assert.match(page.$("menu-list").innerHTML, /data-id="16"/);
  });

  test("an expired saved sign-in goes to login and forgets the token", async () => {
    const page = appPage({ storage: signedIn, routes: { "GET /auth/sso": reply(401, { detail: "Invalid or expired token" }) } });
    await settle();
    assert.equal(activeScreen(page), "login");
    assert.equal(page.localStorage.getItem("token"), null);
    assert.match(page.$("login-error").textContent, /expired/);
  });

  test("server unreachable: the splash screen says so and offers Try again", async () => {
    const page = appPage({ storage: signedIn, offline: true });
    await settle();
    assert.equal(activeScreen(page), "splash");
    assert.match(page.$("splash-message").textContent, /Can't reach the bakery server/);
    assert.equal(page.$("splash-retry").hidden, false);
    assert.equal(page.localStorage.getItem("token"), "good-token", "being offline doesn't sign you out");

    page.server.offline = false;
    page.$("splash-retry").fire("click");
    await settle();
    assert.equal(activeScreen(page), "home");
  });

  test("Home, Order and Settings need a sign-in", async () => {
    const page = appPage();
    await settle();
    for (const screen of ["home", "order", "settings"]) {
      page.run(`showScreen("${screen}")`);
      assert.equal(activeScreen(page), "login", screen + " should send you to login");
    }
  });
});

describe("login and register", () => {
  test("logging in saves the token and opens Home", async () => {
    const page = appPage({ routes: { "POST /auth/login": { access_token: "new-token", token_type: "bearer", user: SAMPLE.customer } } });
    await settle();
    page.$("email").value = " thabo@gmail.com ";
    page.$("password").value = "Pass@1234";
    page.$("login-form").fire("submit");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.path === "/auth/login").body, { email: "thabo@gmail.com", password: "Pass@1234" });
    assert.equal(page.localStorage.getItem("token"), "new-token");
    assert.equal(activeScreen(page), "home");
  });

  test("a wrong password shows the message and stays on login", async () => {
    const page = appPage({ routes: { "POST /auth/login": reply(401, { detail: "Invalid email or password" }) } });
    await settle();
    page.$("login-form").fire("submit");
    await settle();
    assert.equal(page.$("login-error").textContent, "Invalid email or password");
    assert.equal(activeScreen(page), "login");
  });

  test("registering sends no phone if it was left empty", async () => {
    const page = appPage({ routes: { "POST /auth/register": reply(201, { access_token: "t", token_type: "bearer", user: SAMPLE.customer }) } });
    await settle();
    page.$("reg-name").value = "Thabo Nkosi";
    page.$("reg-email").value = "thabo@gmail.com";
    page.$("reg-phone").value = "";
    page.$("reg-password").value = "Pass@1234";
    page.$("register-form").fire("submit");
    await settle();
    assert.equal(page.server.calls.find((c) => c.path === "/auth/register").body.phone, null);
    assert.equal(activeScreen(page), "home");
  });

  test("log out forgets the token", async () => {
    const page = appPage({ storage: signedIn });
    await settle();
    page.$("logout").fire("click");
    assert.equal(page.localStorage.getItem("token"), null);
    assert.equal(activeScreen(page), "login");
  });
});

describe("menu, cart and ordering", () => {
  test("search filters the menu by name or category", async () => {
    const page = appPage({ storage: signedIn, routes: { "GET /products": SAMPLE.products.map((p) => ({ ...p, category: { name: p.category_id === 11 ? "Frappes" : "Cakes" } })) } });
    await settle();
    page.$("search").value = "frappe";
    page.$("search").fire("input");
    assert.doesNotMatch(page.$("menu-list").innerHTML, /Chocolate Cake/);
    assert.match(page.$("menu-list").innerHTML, /Oreo Frappe/);
    page.$("search").value = "zzz";
    page.$("search").fire("input");
    assert.equal(page.$("menu-status").textContent, "Nothing matches your search.");
  });

  test("Add puts the item in the cart and updates the Order link", async () => {
    const page = appPage({ storage: signedIn });
    await settle();
    clickAdd(page, 16);
    clickAdd(page, 16);
    assert.deepEqual(savedCart(page), [{ id: 16, name: "Caramel Frappe", price: 45, qty: 2 }]);
    assert.equal(page.orderLink.textContent, "Order (2)");
  });

  test("setting a quantity to 0 removes the item", async () => {
    const page = appPage({ storage: { ...signedIn, "app-cart": JSON.stringify([{ id: 16, name: "Caramel Frappe", price: 45, qty: 2 }]) } });
    await settle();
    page.run(`showScreen("order")`);
    const input = Object.assign(new FakeElement({ dataset: { index: "0" }, matches: ["input[data-index]"] }), { value: "0" });
    page.$("cart-list").fire("change", { target: input });
    assert.deepEqual(savedCart(page), []);
    assert.equal(page.$("place-order").disabled, true);
  });

  test("placing an order sends it, empties the cart and shows it in Recent orders", async () => {
    const order = { id: 31, user_id: 3, total: 90, status: "pending", created_at: "2026-10-09T10:00:00",
      items: [{ product_id: 16, product: { name: "Caramel Frappe" }, quantity: 2 }] };
    let ordered = false;
    const page = appPage({
      storage: { ...signedIn, "app-cart": JSON.stringify([{ id: 16, name: "Caramel Frappe", price: 45, qty: 2 }]) },
      routes: {
        "POST /orders": () => { ordered = true; return reply(201, order); },
        "GET /orders": () => (ordered ? [order] : []),
      },
    });
    await settle();
    page.run(`showScreen("order")`);
    await settle();
    assert.equal(page.$("cart-total").textContent, "R90");
    page.$("address").value = "12 Main St";
    page.$("place-order").fire("click");
    await settle();
    assert.deepEqual(page.server.calls.find((c) => c.method === "POST").body,
      { items: [{ product_id: 16, quantity: 2 }], delivery_address: "12 Main St", notes: null });
    assert.equal(page.$("order-message").textContent, "Thank you! Order #31 is placed (R90). Status: pending.");
    assert.deepEqual(savedCart(page), []);
    assert.match(page.$("history-list").innerHTML, /Order #31/);
    assert.match(page.$("history-list").innerHTML, /2 × Caramel Frappe/);
  });

  test("a failed order keeps the cart and shows why", async () => {
    const page = appPage({
      storage: { ...signedIn, "app-cart": JSON.stringify([{ id: 99, name: "Pumpkin Pie", price: 30, qty: 1 }]) },
      routes: { "POST /orders": reply(404, { detail: "Product 99 not found or unavailable" }) },
    });
    await settle();
    page.run(`showScreen("order")`);
    page.$("place-order").fire("click");
    await settle();
    assert.equal(page.$("order-message").textContent, "Product 99 not found or unavailable");
    assert.equal(savedCart(page).length, 1);
    assert.equal(page.$("place-order").disabled, false, "you can try again");
  });
});

describe("settings", () => {
  test("preferences are saved on this device and come back next time", async () => {
    const first = appPage({ storage: signedIn });
    await settle();
    const form = first.$("preferences-form");
    form.offers.checked = true;
    form.theme.value = "Light";
    form.fire("submit");
    const saved = first.localStorage.getItem("app-preferences");
    assert.deepEqual(JSON.parse(saved), { notifications: true, offers: true, theme: "Light" });

    const second = appPage({ storage: { ...signedIn, "app-preferences": saved } });
    assert.equal(second.$("preferences-form").offers.checked, true);
    assert.equal(second.$("preferences-form").theme.value, "Light");
  });
});
