// A tiny stand-in for a browser, so the website's scripts can be tested with Node alone
// (no npm install, no real browser, and no requests to the real server).
//
//   const page = loadPage(["bake/api.js", "bake/cart.js"], { server: fakeServer({...}) });
//   await settle();               // let the scripts' promises finish
//   page.$("cart-total").textContent
//
// Objects created inside the page (arrays, errors) come from a different JS "realm",
// so compare them with plain(...) before assert.deepEqual.

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach((n) => this.names.add(n)); }
  remove(...names) { names.forEach((n) => this.names.delete(n)); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : !!force;
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
}

export class FakeElement {
  // matches: the selectors this element answers to in closest(), e.g. [".btn-add"]
  constructor({ id = "", dataset = {}, matches = [], classes = [] } = {}) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.href = "";
    this.title = "";
    this.tabIndex = 0;
    this.textContent = "";
    this.valid = true;
    this.validationMessage = "";
    this.dataset = { ...dataset };
    this.attributes = {};
    this.children = [];
    this.classList = new FakeClassList();
    this.classList.add(...classes);
    this.matchesSelectors = matches;
    this.listeners = {};
    this.queried = {};
    this._html = "";
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  // Everything shown inside the element: its HTML plus any appended child elements
  get html() { return this._html + this.children.map((c) => c.html || c.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  closest(selector) { return this.matchesSelectors.includes(selector) ? this : null; }
  querySelector(selector) { return (this.queried[selector] ||= new FakeElement()); }
  checkValidity() { return this.valid; }
  reset() { this.wasReset = true; }
  focus() {}
  // Fire an event on this element; extra fields (like target) go on the event
  fire(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (this.listeners[type] || []).forEach((fn) => fn(event));
    return event;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super();
    this.elements = {};
    this.selectors = {};      // querySelector results the test sets up
    this.selectorLists = {};  // querySelectorAll results the test sets up
    this.documentElement = new FakeElement();
    this.body = new FakeElement();
  }
  getElementById(id) { return (this.elements[id] ||= new FakeElement({ id })); }
  querySelector(selector) { return this.selectors[selector] || null; }
  querySelectorAll(selector) { return this.selectorLists[selector] || []; }
  createElement() { return new FakeElement(); }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach((fn) => fn(event)); return true; }
}

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

// A reply with a status code other than 200, e.g. reply(401, { detail: "Invalid token" })
const REPLY = Symbol("reply");
export const reply = (status, body) => ({ [REPLY]: true, status, body });

// A fake API server. routes: { "GET /products": body | reply(...) | (request) => either }
// Unknown routes answer 404. server.calls records every request the page made.
export function fakeServer(routes = {}) {
  const calls = [];
  async function fetch(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const pathname = new URL(url).pathname + new URL(url).search;
    const request = { method, path: pathname, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(request);
    if (server.offline) throw new TypeError("Failed to fetch");
    let route = routes[method + " " + pathname] ?? routes[method + " " + pathname.split("?")[0]];
    if (typeof route === "function") route = await route(request);
    if (route === undefined) route = reply(404, { detail: "Not Found" });
    const answer = route && route[REPLY] ? route : reply(200, route);
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => { if (answer.body === undefined) throw new SyntaxError("No JSON"); return JSON.parse(JSON.stringify(answer.body)); },
    };
  }
  const server = { fetch, calls, offline: false, routes };
  return server;
}

// Load page scripts (paths relative to the repo root) into a fresh fake browser
export function loadPage(scripts, { server = fakeServer(), storage = {}, url = "https://example.test/index.html", setup, confirm = () => true } = {}) {
  const document = new FakeDocument();
  const localStorage = fakeStorage(storage);
  const parsed = new URL(url);
  const location = {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    href: url,
    replaced: null,
    replace(target) { this.replaced = target; },
    reload() { this.reloaded = true; },
  };
  const context = {
    document,
    localStorage,
    location,
    fetch: server.fetch,
    console: { log() {}, warn() {}, error() {} },
    history: { replaceState(state, title, hash) { location.hash = hash; } },
    // Look these up at call time, so the tests' mocked timers apply
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    AbortController,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    matchMedia: () => ({ matches: false }),
    scrollTo() {},
    confirm,
  };
  context.window = context;
  vm.createContext(context);
  if (setup) setup(document, context);
  for (const script of scripts) {
    vm.runInContext(readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }
  return {
    window: context,
    document,
    localStorage,
    location,
    server,
    $: (id) => document.getElementById(id),
    run: (code) => vm.runInContext(code, context), // reach the script's own top-level helpers
  };
}

// Let pending promises (fake server replies, then the code waiting on them) finish
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Copy a value out of the page's realm so assert.deepEqual compares it fairly
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Sample data shaped like the real API's replies
export const SAMPLE = {
  customer: { id: 3, name: "Thabo Nkosi", email: "thabo@gmail.com", role: "customer", phone: "0821234567", created_at: "2026-10-01T08:00:00" },
  admin: { id: 1, name: "Admin User", email: "admin@thebakery.co.za", role: "admin", phone: null, created_at: "2026-10-01T08:00:00" },
  categories: [
    { id: 2, name: "Cakes", description: null },
    { id: 8, name: "Beverages", description: null },
    { id: 11, name: "Frappes", description: null },
  ],
  products: [
    { id: 4, name: "Chocolate Cake", description: null, price: 45, category_id: 2, is_available: true, created_at: "2026-10-01T08:00:00" },
    { id: 16, name: "Caramel Frappe", description: null, price: 45, category_id: 11, is_available: true, created_at: "2026-10-01T08:00:00" },
    { id: 17, name: "Oreo Frappe", description: null, price: 54, category_id: 11, is_available: true, created_at: "2026-10-01T08:00:00" },
  ],
};
