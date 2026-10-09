"""Checks for backend/seed.py, the sample data the server loads on every start.

The seed file is read, not run, so these tests need no installed packages and no database:
    python -m unittest discover -s tests/backend -v
"""
import ast
import html
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "backend" / "seed.py"
WEBSITE_MENU = ROOT / "bake" / "index.html"

# The mobile app relies on these IDs, so the first rows must never change order
ORIGINAL_CATEGORIES = ["Breads", "Cakes", "Pastries", "Muffins", "Cookies", "Pies", "Rolls", "Beverages", "Specials", "Gluten-Free"]
ORIGINAL_PRODUCTS = [
    "White Loaf", "Whole Wheat Loaf", "Sourdough Loaf", "Chocolate Cake", "Carrot Cake", "Red Velvet Cake",
    "Butter Croissant", "Almond Danish", "Blueberry Muffin", "Choc Chip Muffin", "Choc Chip Cookies",
    "Peanut Butter Cookies", "Chicken Pie", "Caramel Latte", "GF Banana Bread",
]
ORDER_STATUSES = {"pending", "confirmed", "preparing", "ready", "delivered", "cancelled"}  # routers/orders.py


def seed_lists():
    """Read the four data lists out of seed.py without running it."""
    found = {}
    for node in ast.parse(SEED.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ("categories_data", "products_data", "users_data", "orders_data"):
                found[name] = ast.literal_eval(node.value)
    return found


def website_menu():
    """Name -> price for every Add button on the website's built-in menu."""
    text = WEBSITE_MENU.read_text(encoding="utf-8")
    return {html.unescape(n): float(p) for n, p in re.findall(r'class="btn-add" data-name="([^"]+)" data-price="([^"]+)"', text)}


class SeedData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = seed_lists()
        cls.categories = data["categories_data"]
        cls.products = data["products_data"]
        cls.users = data["users_data"]
        cls.orders = data["orders_data"]
        cls.visible = {p["name"]: p for p in cls.products if p.get("available", True)}

    # ── IDs the mobile app depends on ──
    def test_category_ids_1_to_10_are_unchanged(self):
        self.assertEqual([c["name"] for c in self.categories[:10]], ORIGINAL_CATEGORIES)

    def test_product_ids_1_to_15_are_unchanged(self):
        self.assertEqual([p["name"] for p in self.products[:15]], ORIGINAL_PRODUCTS)

    # ── The menu customers see ──
    def test_visible_menu_matches_the_website_menu(self):
        seeded = {name: p["price"] for name, p in self.visible.items()}
        self.assertEqual(seeded, website_menu(), "seed.py and bake/index.html should list the same items at the same prices")

    def test_every_product_has_a_real_category(self):
        names = {c["name"] for c in self.categories}
        for p in self.products:
            self.assertIn(p["category"], names, p["name"])

    def test_prices_are_positive(self):
        for p in self.products:
            self.assertGreater(p["price"], 0, p["name"])

    # ── Things that would make the seed crash on the server ──
    def test_category_names_are_unique(self):
        # categories.name is UNIQUE in models.py, so a repeat would stop the seed
        names = [c["name"] for c in self.categories]
        self.assertEqual(len(names), len(set(names)))

    def test_product_names_are_unique(self):
        # orders look products up by name, so a repeat would attach orders to the wrong one
        names = [p["name"] for p in self.products]
        self.assertEqual(len(names), len(set(names)))

    def test_user_emails_are_unique(self):
        emails = [u["email"] for u in self.users]
        self.assertEqual(len(emails), len(set(emails)))

    def test_text_fits_the_database_columns(self):
        # Column sizes from models.py
        for c in self.categories:
            self.assertLessEqual(len(c["name"]), 100, c["name"])
        for p in self.products:
            self.assertLessEqual(len(p["name"]), 150, p["name"])
        for u in self.users:
            self.assertLessEqual(len(u["name"]), 100, u["name"])
            self.assertLessEqual(len(u["email"]), 150, u["email"])
            self.assertLessEqual(len(u.get("phone") or ""), 20, u["name"])

    # ── Sample orders ──
    def test_orders_only_use_items_on_the_menu(self):
        for o in self.orders:
            for name, qty in o["items"]:
                self.assertIn(name, self.visible, f"order for user {o['user_idx']} uses {name}, which is hidden or missing")
                self.assertGreaterEqual(qty, 1)

    def test_orders_belong_to_customers_that_exist(self):
        for o in self.orders:
            self.assertLess(o["user_idx"], len(self.users))
            self.assertEqual(self.users[o["user_idx"]].get("role", "customer"), "customer")

    def test_order_statuses_are_ones_the_server_accepts(self):
        for o in self.orders:
            self.assertIn(o["status"], ORDER_STATUSES)

    # ── Test accounts from the team's connection guide ──
    def test_guide_test_accounts_exist(self):
        by_email = {u["email"]: u for u in self.users}
        self.assertEqual(by_email["admin@thebakery.co.za"]["role"], "admin")
        self.assertEqual(by_email["thabo@gmail.com"].get("role", "customer"), "customer")


if __name__ == "__main__":
    unittest.main()
