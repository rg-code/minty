// Swipe actions on a trip's bookings (docs/trips.md §31), like Minty's transactions (public/swipe.js):
// drag a card right for Google Maps, left for Edit; a long drag does it. Touch and pen only: a mouse
// opens the booking, whose page has both. kos.js does the actions (a "kosaction" event on #app). The
// card moves with transform only, and the buttons are added behind the one card being dragged.
(() => {
  const app = document.getElementById("app");
  if (!app) return;
  const LEAD = [["maps", "Maps"]], TRAIL = [["edit", "Edit"]];
  const CARD = ".stop > button.item[data-item], .stop > article.flight[data-item], .plan > article.flight[data-item], .plan > button.item.stay[data-item]";
  const BTN = 88, EDGE = 24, DECIDE = 8, FULL = 0.55;
  let drag = null, open = null, swallowUntil = 0;
  const act = (card, name) => app.dispatchEvent(new CustomEvent("kosaction", { detail: { id: Number(card.dataset.item), act: name } }));
  const swallow = () => { swallowUntil = Date.now() + 400; };

  function panelFor(card) {
    let p = card.previousElementSibling?.classList.contains("kos-swipe") ? card.previousElementSibling : null;
    if (!p) {
      p = document.createElement("div");
      p.className = "kos-swipe";
      p.setAttribute("aria-hidden", "true");                                // the booking's page has the accessible buttons
      const b = ([a, label]) => `<button type="button" tabindex="-1" data-kos-swipe="${a}">${label}</button>`;
      p.innerHTML = `<div class="lead">${LEAD.map(b).join("")}</div><div class="trail">${TRAIL.map(b).join("")}</div>`;
      card.before(p);
    }
    Object.assign(p.style, { top: `${card.offsetTop}px`, left: `${card.offsetLeft}px`, width: `${card.offsetWidth}px`, height: `${card.offsetHeight}px` });
    return p;
  }
  function place(card, panel, x, animate) {
    card.classList.toggle("dragging", !animate);
    panel.classList.toggle("dragging", !animate);
    card.style.transform = x ? `translate3d(${x}px, 0, 0)` : "";
    panel.style.setProperty("--gap", `${Math.abs(x)}px`);
    panel.dataset.side = x > 0 ? "lead" : x < 0 ? "trail" : "";
  }
  function settle({ card, panel }, x) {
    panel.classList.remove("full");
    place(card, panel, x, true);
    if (x) { open = { card, panel, x }; return; }
    if (open?.card === card) open = null;
    setTimeout(() => { if (open?.card !== card && drag?.card !== card) panel.remove(); }, 300);
  }
  const close = () => { if (open) settle(open, 0); };

  document.addEventListener("pointerdown", (e) => {
    if (open && !open.card.isConnected) open = null;                        // the page was redrawn
    if (!open || e.target.closest(".kos-swipe") || e.target.closest("[data-item]") === open.card) return;
    close();
    swallow();
  }, true);
  window.addEventListener("scroll", () => { if (open && !drag) close(); }, { passive: true });

  app.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    const card = e.target.closest(CARD);
    if (!card || e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
    drag = { id: e.pointerId, card, x0: e.clientX, y0: e.clientY, base: open?.card === card ? open.x : 0, swiping: false, x: 0 };
  });
  app.addEventListener("pointermove", (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.swiping) {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) { drag = null; return; }      // a scroll: the browser's
      d.swiping = true;
      if (open && open.card !== d.card) close();
      d.card.setPointerCapture?.(e.pointerId);
      d.panel = panelFor(d.card);
      d.w = d.card.offsetWidth;
    }
    d.x = Math.max(-d.w, Math.min(d.w, d.base + dx));
    const full = Math.abs(d.x) > d.w * FULL;
    if (full && !d.panel.classList.contains("full") && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
    d.panel.classList.toggle("full", full);
    place(d.card, d.panel, d.x, false);
  });
  function end(e) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (!d.swiping) { if (d.base && e.type === "pointerup") { close(); swallow(); } return; }
    swallow();
    const side = d.x > 0 ? LEAD : TRAIL;
    if (e.type === "pointerup" && Math.abs(d.x) > d.w * FULL) { settle(d, 0); act(d.card, side[side.length - 1][0]); return; }
    const opened = side.length * BTN;
    const opening = Math.abs(d.x) > Math.abs(d.base) ? Math.abs(d.x) > 36 : Math.abs(d.x) > opened - 36;
    settle(d, opening && e.type === "pointerup" ? Math.sign(d.x) * opened : 0);
  }
  app.addEventListener("pointerup", end);
  app.addEventListener("pointercancel", end);
  app.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kos-swipe]");
    if (b) {
      e.stopImmediatePropagation();
      const card = b.closest(".kos-swipe")?.nextElementSibling;
      close();
      if (card) act(card, b.dataset.kosSwipe);
      return;
    }
    if (Date.now() < swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
})();
