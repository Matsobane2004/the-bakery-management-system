// Checks on the real HTML pages: the unit tests use a fake page, so these make sure the
// real pages have everything the scripts expect, and that every linked file exists.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../helpers/fake-browser.mjs";

const PAGES = [
  ...readdirSync(path.join(ROOT, "bake")).filter((f) => f.endsWith(".html")).map((f) => "bake/" + f),
  "bakery-app/app-wireframe.html",
];
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const scriptsOf = (page) => [...read(page).matchAll(/<script src="([^"]+)"/g)].map((m) => path.posix.join(path.posix.dirname(page), m[1]));
const idsIn = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
// IDs a script looks up: document.getElementById("x") or $("x")
const idsUsedBy = (script) => [...new Set([...read(script).matchAll(/(?:getElementById|\$)\(\s*["']([\w-]+)["']\s*\)/g)].map((m) => m[1]))];

// Exact-case check (Windows doesn't care about capitals, but the Linux server does)
function existsExactly(file) {
  let dir = ROOT;
  for (const part of file.split("/")) {
    if (!readdirSync(dir).includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

describe("every element a script needs is on the page", () => {
  for (const page of PAGES) {
    for (const script of scriptsOf(page)) {
      test(`${page} has every id ${path.basename(script)} uses`, () => {
        const ids = new Set(idsIn(read(page)));
        const missing = idsUsedBy(script).filter((id) => !ids.has(id));
        assert.deepEqual(missing, []);
      });
    }
  }

  test("the home page has the menu grid that public-menu.js fills", () => {
    assert.match(read("bake/index.html"), /id="menu"[\s\S]*class="menu-grid"/);
  });
});

describe("page structure", () => {
  for (const page of PAGES) {
    test(`${page} has no repeated ids`, () => {
      const seen = new Set();
      const repeated = idsIn(read(page)).filter((id) => seen.has(id) || !seen.add(id));
      assert.deepEqual(repeated, []);
    });

    test(`${page} loads api.js before the scripts that use it`, () => {
      const names = scriptsOf(page).map((s) => path.basename(s));
      for (const user of ["cart.js", "account.js", "admin.js", "public-menu.js"]) {
        if (names.includes(user)) assert.ok(names.indexOf("api.js") > -1 && names.indexOf("api.js") < names.indexOf(user), `${user} needs api.js first`);
      }
    });
  }
});

describe("every linked file exists (with exact capitals)", () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      const refs = [
        ...[...html.matchAll(/\s(?:src|href|poster|data-video)="([^"]+)"/g)].map((m) => m[1]),
        ...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+/)[0])),
      ];
      const local = refs.filter((r) => !/^(https?:|mailto:|tel:|data:|#|\/\/)/.test(r)).map((r) => r.split(/[?#]/)[0]).filter(Boolean);
      const broken = local
        .map((r) => path.posix.normalize(path.posix.join(path.posix.dirname(page), r)))
        .filter((file) => !existsExactly(file));
      assert.deepEqual([...new Set(broken)], []);
    });
  }

  test("the original phone videos are kept out of git", () => {
    assert.match(read(".gitignore"), /^bake\/videos\/originals\/$/m);
    assert.ok(existsSync(path.join(ROOT, "bake/videos")), "the web videos folder exists");
  });
});
