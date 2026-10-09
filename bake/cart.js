// The Bakery — cart. Orders are placed through the backend API (POST /orders).
// The cart is saved in this browser, so it survives changing pages and signing in.
// If the server can't be reached, the customer can still send the order on WhatsApp.
(function () {
  "use strict";

  const STORAGE_KEY = "bakery-cart";
  const WHATSAPP_NUMBER = "27813586602"; // 081 358 6602 in international format, no "+" or leading 0
  const API = window.BakeryAPI;

  const els = {
    open: document.getElementById("cart-open"),
    close: document.getElementById("cart-close"),
    overlay: document.getElementById("cart-overlay"),
    drawer: document.getElementById("cart-drawer"),
    items: document.getElementById("cart-items"),
    empty: document.getElementById("cart-empty"),
    count: document.getElementById("cart-count"),
    total: document.getElementById("cart-total"),
    notice: document.getElementById("cart-notice-text"),
    fields: document.getElementById("cart-fields"),
    address: document.getElementById("cart-address"),
    notes: document.getElementById("cart-notes"),
    message: document.getElementById("cart-message"),
    checkout: document.getElementById("cart-checkout"),
    whatsapp: document.getElementById("cart-whatsapp"),
  };

  // Each item: { id, name, price, qty }. id is the product id from the server
  // (null if it was added from the backup menu while the server was offline).
  let cart = loadCart();
  let lastOrder = null; // shown as a thank-you message after ordering
  let placing = false;

  function loadCart() {
    try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); return Array.isArray(saved) ? saved : []; } catch (e) { return []; }
  }
  function saveCart() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); } catch (e) {}
  }

  const price = (n) => (API ? API.formatPrice(n) : "R" + n);
  const esc = (s) => (API ? API.escapeHtml(s) : String(s));
  const signedIn = () => !!(API && API.getToken());
  const subtotal = () => cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  const canOrderOnline = () => !!API && cart.length > 0 && cart.every((i) => i.id);

  function openCart() {
    els.overlay.hidden = false;
    els.drawer.classList.add("open");
    els.drawer.setAttribute("aria-hidden", "false");
  }
  function closeCart() {
    els.overlay.hidden = true;
    els.drawer.classList.remove("open");
    els.drawer.setAttribute("aria-hidden", "true");
  }

  function addItem(id, name, unitPrice) {
    lastOrder = null;
    const existing = cart.find((i) => (id ? i.id === id : i.name === name));
    if (existing) existing.qty += 1;
    else cart.push({ id: id || null, name: name, price: unitPrice, qty: 1 });
    saveCart();
    render();
  }

  function changeQty(index, delta) {
    const item = cart[index];
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) cart.splice(index, 1);
    saveCart();
    render();
  }

  function setMessage(text, isError) {
    els.message.textContent = text || "";
    els.message.classList.toggle("error", !!isError);
  }

  // WhatsApp message with the order typed out
  function whatsappHref() {
    const lines = cart.map((i) => "- " + i.qty + " x " + i.name + " (" + price(i.price * i.qty) + ")");
    let text = "Hi! I'd like to order:\n" + lines.join("\n") + "\nTotal: " + price(subtotal());
    if (els.address.value.trim()) text += "\nDeliver to: " + els.address.value.trim();
    if (els.notes.value.trim()) text += "\nNote: " + els.notes.value.trim();
    return "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(text);
  }

  function render() {
    // Item rows (or the thank-you message after an order)
    els.items.innerHTML = "";
    if (cart.length === 0 && lastOrder) {
      els.items.innerHTML =
        '<div class="cart-success" role="status">' +
          '<p class="cart-success-title">Thank you! Order #' + lastOrder.id + " is in.</p>" +
          "<p>Total " + price(lastOrder.total) + " · Status: " + esc(lastOrder.status) + ". You can follow it on your account page.</p>" +
          '<a href="account.html#orders" class="btn btn-outline full">Track my order</a>' +
        "</div>";
    } else if (cart.length === 0) {
      els.items.appendChild(els.empty);
    } else {
      cart.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "cart-row";
        row.innerHTML =
          '<div class="cart-row-info">' +
            '<span class="cart-row-name">' + esc(item.name) + "</span>" +
            '<span class="cart-row-price">' + price(item.price) + " each</span>" +
          "</div>" +
          '<div class="cart-qty">' +
            '<button type="button" class="qty-btn" data-index="' + index + '" data-delta="-1" aria-label="Remove one ' + esc(item.name) + '">&minus;</button>' +
            '<span class="qty-num">' + item.qty + "</span>" +
            '<button type="button" class="qty-btn" data-index="' + index + '" data-delta="1" aria-label="Add one more ' + esc(item.name) + '">+</button>' +
          "</div>" +
          '<span class="cart-row-total">' + price(item.price * item.qty) + "</span>";
        els.items.appendChild(row);
      });
    }

    // Totals + navbar badge
    const count = cart.reduce((sum, i) => sum + i.qty, 0);
    els.total.textContent = price(subtotal());
    els.count.textContent = count;
    els.count.classList.toggle("has-items", count > 0);

    // Who is ordering, and which buttons make sense right now
    const user = API && API.getUser();
    if (!API || (cart.length && !canOrderOnline())) {
      els.notice.textContent = "Online ordering is unavailable right now. Send your order on WhatsApp instead.";
    } else if (signedIn() && user) {
      els.notice.textContent = "Ordering as " + user.name + ". Follow your order on your account page.";
    } else {
      els.notice.textContent = "Sign in or create an account to order online, or send your order on WhatsApp.";
    }

    els.fields.hidden = cart.length === 0;
    els.checkout.hidden = cart.length > 0 && !canOrderOnline();
    els.checkout.disabled = cart.length === 0 || placing;
    els.checkout.textContent = placing ? "Placing order…" : signedIn() ? "Place order" : "Sign in to order";
    els.whatsapp.hidden = cart.length === 0;
    if (cart.length) els.whatsapp.href = whatsappHref();
  }

  async function checkout() {
    if (!cart.length || placing) return;
    if (!signedIn()) {
      // Come back to this page with the cart open after signing in
      const page = location.pathname.split("/").pop() || "index.html";
      location.href = "account.html?next=" + encodeURIComponent(page + "#cart");
      return;
    }
    placing = true;
    setMessage("");
    render();
    try {
      const order = await API.api("/orders", {
        method: "POST",
        body: JSON.stringify({
          items: cart.map((i) => ({ product_id: i.id, quantity: i.qty })),
          delivery_address: els.address.value.trim() || null,
          notes: els.notes.value.trim() || null,
        }),
      });
      lastOrder = order;
      cart = [];
      saveCart();
      els.address.value = "";
      els.notes.value = "";
    } catch (err) {
      // The server names a product that is no longer sold as "Product 16 not found or unavailable"
      const gone = err.status === 404 && /Product (\d+)/.exec(err.message);
      const goneItem = gone && cart.find((i) => i.id === Number(gone[1]));
      setMessage(
        err.status === 401 ? "Your sign-in has expired. Please sign in again." :
        goneItem ? goneItem.name + " is no longer available. Remove it from your cart to place your order." :
        err.message, true);
    } finally {
      placing = false;
      render();
    }
  }

  // When the menu arrives from the server, match items that were added earlier
  // (e.g. from the backup menu) to the real products, and use the current prices.
  // Items that are no longer on the menu are taken out, so they can't block the order.
  document.addEventListener("bakery:menu-loaded", (e) => {
    const products = e.detail || [];
    if (!products.length) return; // menu being updated: keep the cart as it is
    const removed = [];
    cart = cart.filter((item) => {
      const match = products.find((p) => (item.id ? p.id === item.id : p.name.toLowerCase() === item.name.toLowerCase()));
      if (!match) { removed.push(item.name); return false; }
      item.id = match.id; item.name = match.name; item.price = match.price;
      return true;
    });
    saveCart();
    render();
    if (removed.length) {
      setMessage(removed.join(", ") + (removed.length === 1 ? " is" : " are") + " no longer on the menu, so " +
        (removed.length === 1 ? "it was" : "they were") + " taken out of your cart.", true);
    }
  });

  // "Add" buttons (delegated, because the menu is drawn after the page loads)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-add");
    if (!btn) return;
    addItem(btn.dataset.id ? Number(btn.dataset.id) : null, btn.dataset.name, Number(btn.dataset.price));
    btn.classList.add("added");
    btn.textContent = "Added";
    setTimeout(() => { btn.classList.remove("added"); btn.textContent = "Add"; }, 900);
  });

  // Quantity buttons (delegated)
  els.items.addEventListener("click", (e) => {
    const btn = e.target.closest(".qty-btn");
    if (btn) changeQty(Number(btn.dataset.index), Number(btn.dataset.delta));
  });

  els.open.addEventListener("click", openCart);
  els.close.addEventListener("click", closeCart);
  els.overlay.addEventListener("click", closeCart);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCart(); });
  els.checkout.addEventListener("click", checkout);
  // Keep the WhatsApp message up to date with the address and note
  [els.address, els.notes].forEach((input) => input.addEventListener("input", () => { if (cart.length) els.whatsapp.href = whatsappHref(); }));

  render();
  if (API) API.ready.then(render, () => {}); // the sign-in check may have found an expired token
  if (location.hash === "#cart") openCart(); // back from signing in
})();
