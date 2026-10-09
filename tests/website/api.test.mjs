// Tests for bake/api.js — the shared connection to the backend API.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPage, fakeServer, reply, settle, plain, SAMPLE } from "../helpers/fake-browser.mjs";

const signedIn = { token: "good-token", "bakery-user": JSON.stringify(SAMPLE.customer) };

describe("formatPrice", () => {
  const { formatPrice } = loadPage(["bake/api.js"]).window.BakeryAPI;

  test("whole rands have no cents", () => assert.equal(formatPrice(45), "R45"));
  test("cents are always two digits", () => assert.equal(formatPrice(12.5), "R12.50"));
  test("numbers sent as text still work", () => assert.equal(formatPrice("35"), "R35"));
  test("missing or invalid prices show R0", () => {
    assert.equal(formatPrice(undefined), "R0");
    assert.equal(formatPrice("abc"), "R0");
  });
});

describe("formatDate", () => {
  const { formatDate } = loadPage(["bake/api.js"]).window.BakeryAPI;

  test("server times without a time zone are read as UTC", () => {
    assert.equal(formatDate("2026-10-08T10:00:00"), formatDate("2026-10-08T10:00:00Z"));
  });
  test("times that already have a time zone are not changed", () => {
    assert.equal(formatDate("2026-10-08T12:00:00+02:00"), formatDate("2026-10-08T10:00:00Z"));
  });
  test("shows day, month and year", () => {
    assert.match(formatDate("2026-10-08T10:00:00Z"), /8 Oct 2026/);
  });
  test("empty or unreadable dates don't crash", () => {
    assert.equal(formatDate(""), "");
    assert.equal(formatDate(null), "");
    assert.equal(formatDate("not a date"), "not a date");
  });
});

describe("escapeHtml", () => {
  const { escapeHtml } = loadPage(["bake/api.js"]).window.BakeryAPI;

  test("special characters are shown as text, not treated as HTML", () => {
    assert.equal(escapeHtml(`<b>"Tom" & 'Jerry'</b>`), "&lt;b&gt;&quot;Tom&quot; &amp; &#039;Jerry&#039;&lt;/b&gt;");
  });
  test("null and numbers are handled", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(45), "45");
  });
});

describe("api() request helper", () => {
  test("sends the saved token with every request", async () => {
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "GET /orders": [] });
    const page = loadPage(["bake/api.js"], { server, storage: signedIn });
    await page.window.BakeryAPI.api("/orders");
    const call = server.calls.find((c) => c.path === "/orders");
    assert.equal(call.headers.Authorization, "Bearer good-token");
    assert.equal(call.headers["Content-Type"], "application/json");
  });

  test("sends no token when nobody is signed in", async () => {
    const server = fakeServer({ "GET /products": [] });
    const page = loadPage(["bake/api.js"], { server });
    await page.window.BakeryAPI.api("/products");
    assert.equal(server.calls.length, 1, "only the /products request, no SSO check");
    assert.equal(server.calls[0].headers.Authorization, undefined);
  });

  test("returns the server's answer", async () => {
    const page = loadPage(["bake/api.js"], { server: fakeServer({ "GET /products": SAMPLE.products }) });
    assert.deepEqual(plain(await page.window.BakeryAPI.api("/products")), SAMPLE.products);
  });

  test("a 401 (expired sign-in) clears the saved sign-in", async () => {
    const server = fakeServer({ "GET /auth/sso": SAMPLE.customer, "GET /orders": reply(401, { detail: "Invalid or expired token" }) });
    const page = loadPage(["bake/api.js"], { server, storage: signedIn });
    await settle();
    await assert.rejects(page.window.BakeryAPI.api("/orders"), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.message, "Invalid or expired token");
      return true;
    });
    assert.equal(page.localStorage.getItem("token"), null);
    assert.equal(page.localStorage.getItem("bakery-user"), null);
  });

  test("form mistakes (422) name the field that is wrong", async () => {
    const server = fakeServer({
      "POST /auth/register": reply(422, { detail: [{ loc: ["body", "email"], msg: "value is not a valid email address" }] }),
    });
    const page = loadPage(["bake/api.js"], { server });
    await assert.rejects(page.window.BakeryAPI.api("/auth/register", { method: "POST", body: "{}" }), {
      message: "email: value is not a valid email address",
    });
  });

  test("errors without a message get a friendly one", async () => {
    const page = loadPage(["bake/api.js"], { server: fakeServer({ "GET /products": reply(500, undefined) }) });
    await assert.rejects(page.window.BakeryAPI.api("/products"), {
      message: "Something went wrong (error 500). Please try again.",
    });
  });

  test("no internet gives status 0 and a clear message", async () => {
    const server = fakeServer();
    server.offline = true;
    const page = loadPage(["bake/api.js"], { server });
    await assert.rejects(page.window.BakeryAPI.api("/products"), (err) => {
      assert.equal(err.status, 0);
      assert.match(err.message, /Can't reach the bakery server/);
      return true;
    });
  });

  test("gives up after 20 seconds if the server doesn't answer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = fakeServer();
    // A server that never answers, but stops when the request is cancelled
    server.fetch = (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const page = loadPage(["bake/api.js"], { server });
    const request = page.window.BakeryAPI.api("/products");
    t.mock.timers.tick(19999);
    await settle(2);
    t.mock.timers.tick(1);
    await assert.rejects(request, (err) => {
      assert.equal(err.status, 0);
      assert.match(err.message, /taking too long/);
      return true;
    });
  });

  test("a 204 reply (after a delete) returns null", async () => {
    const page = loadPage(["bake/api.js"], { server: fakeServer({ "DELETE /products/4": reply(204, undefined) }) });
    assert.equal(await page.window.BakeryAPI.api("/products/4", { method: "DELETE" }), null);
  });
});

describe("sign in and SSO", () => {
  test("login saves the token and the profile", async () => {
    const server = fakeServer({ "POST /auth/login": { access_token: "new-token", token_type: "bearer", user: SAMPLE.customer } });
    const page = loadPage(["bake/api.js"], { server });
    const user = await page.window.BakeryAPI.login("thabo@gmail.com", "Pass@1234");
    assert.equal(user.name, "Thabo Nkosi");
    assert.deepEqual(server.calls[0].body, { email: "thabo@gmail.com", password: "Pass@1234" });
    assert.equal(page.localStorage.getItem("token"), "new-token");
    assert.equal(JSON.parse(page.localStorage.getItem("bakery-user")).email, "thabo@gmail.com");
  });

  test("a wrong password shows the server's message", async () => {
    const server = fakeServer({ "POST /auth/login": reply(401, { detail: "Invalid email or password" }) });
    const page = loadPage(["bake/api.js"], { server });
    await assert.rejects(page.window.BakeryAPI.login("thabo@gmail.com", "wrong"), { message: "Invalid email or password" });
    assert.equal(page.localStorage.getItem("token"), null);
  });

  test("SSO with no saved token returns null without asking the server", async () => {
    const server = fakeServer();
    const page = loadPage(["bake/api.js"], { server });
    assert.equal(await page.window.BakeryAPI.ready, null);
    assert.equal(server.calls.length, 0);
  });

  test("SSO with a valid token returns the user and refreshes the saved profile", async () => {
    const updated = { ...SAMPLE.customer, name: "Thabo N." };
    const page = loadPage(["bake/api.js"], { server: fakeServer({ "GET /auth/sso": updated }), storage: signedIn });
    assert.equal((await page.window.BakeryAPI.ready).name, "Thabo N.");
    assert.equal(JSON.parse(page.localStorage.getItem("bakery-user")).name, "Thabo N.");
  });

  for (const status of [401, 403]) {
    test(`SSO answered with ${status} signs the visitor out`, async () => {
      const server = fakeServer({ "GET /auth/sso": reply(status, { detail: "Not authenticated" }) });
      const page = loadPage(["bake/api.js"], { server, storage: signedIn });
      assert.equal(await page.window.BakeryAPI.ready, null);
      assert.equal(page.localStorage.getItem("token"), null);
    });
  }

  test("SSO while offline keeps the sign-in (being offline is not a reason to sign out)", async () => {
    const server = fakeServer();
    server.offline = true;
    const page = loadPage(["bake/api.js"], { server, storage: signedIn });
    await assert.rejects(page.window.BakeryAPI.ready, (err) => err.status === 0);
    assert.equal(page.localStorage.getItem("token"), "good-token");
  });

  test("logout clears the saved sign-in", () => {
    const page = loadPage(["bake/api.js"], { server: fakeServer({ "GET /auth/sso": SAMPLE.customer }), storage: signedIn });
    page.window.BakeryAPI.logout();
    assert.equal(page.localStorage.getItem("token"), null);
    assert.equal(page.window.BakeryAPI.getUser(), null);
  });

  test("blocked or broken storage doesn't crash the site", async () => {
    const page = loadPage(["bake/api.js"], { storage: { "bakery-user": "{not json" } });
    assert.equal(page.window.BakeryAPI.getUser(), null);
    page.localStorage.getItem = () => { throw new Error("SecurityError"); };
    assert.equal(page.window.BakeryAPI.getToken(), null);
  });

  test("the account icon shows who is signed in", () => {
    const link = { classList: { on: false, toggle(name, on) { this.on = on; } }, attrs: {}, setAttribute(n, v) { this.attrs[n] = v; } };
    loadPage(["bake/api.js"], {
      server: fakeServer({ "GET /auth/sso": SAMPLE.customer }),
      storage: signedIn,
      setup: (document) => { document.selectorLists["[data-account-link]"] = [link]; },
    });
    assert.equal(link.classList.on, true);
    assert.equal(link.attrs["aria-label"], "My account (Thabo Nkosi)");
  });
});
