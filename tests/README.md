# Tests

Automated tests for the website (`bake/`), the app wireframe (`bakery-app/`) and the seed data (`backend/seed.py`).

They need **nothing installed** besides Node.js 20+ and Python 3. There are no npm or pip packages. They also **never contact the real server**: the website tests use a fake browser and a fake API (`tests/helpers/fake-browser.mjs`), so they run offline and can't change live data.

## Run them

From the repository root:

```
node --test
python -m unittest discover -s tests/backend -v
```

`node --test` finds every `*.test.mjs` file on its own.

## What is covered

| File | Tests |
|---|---|
| `website/api.test.mjs` | Prices, dates, HTML escaping, the request helper (token, errors, offline, 20-second timeout), login, SSO, logout |
| `website/cart.test.mjs` | Adding and removing items, totals, saved cart, WhatsApp message, backup menu vs live menu, placing an order, expired sign-in, double clicks, items taken off the menu |
| `website/public-menu.test.mjs` | Menu cards from the API, pictures, escaping, fallback to the backup menu when the server is down |
| `website/account.test.mjs` | SSO on opening, sign in, create account, order history, logout, and only returning to pages on this site after signing in (`?next=`) |
| `website/admin.test.mjs` | Only admins get in, orders and status changes, adding, editing, hiding and deleting menu items |
| `website/pages.test.mjs` | The real HTML pages: every id the scripts use exists, no repeated ids, `api.js` loads first, every linked file exists with exact capitals (the Linux server is case-sensitive) |
| `wireframe/app-wireframe.test.mjs` | The app wireframe: SSO, login, register, menu search, cart, placing an order, settings |
| `backend/test_seed.py` | Category IDs 1–10 and product IDs 1–15 unchanged (the Android app needs them), visible menu = website menu (names and prices), sample orders valid, text fits the database columns |

Test names that start with `BUG:` reproduce a bug that was found and fixed, so it can't come back unnoticed.

## Not covered

- The backend's own routes (`backend/routers/`). Testing them needs FastAPI installed (`pip install -r backend/requirements.txt`).
- Video playback and the lightbox (`bake/videos.js`) and the page layout. Check these by hand in a browser.
