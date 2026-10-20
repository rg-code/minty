// Swipe actions on the dashboard's transactions, like Mail on iOS: drag a row right for Select,
// left for Tag, Similar and Counts as; a long drag does the first one (Select, or Tag). Touch and
// pen only: a mouse opens the row, whose detail has the same buttons. app.js does the actions
// (a "txnaction" event on the feed). Speed: the row moves with transform only, the buttons are
// added to the one row being dragged (never to every row), and the listeners sit on the feed.
(() => {
  const feed = document.getElementById("feed");
  if (!feed) return;
  const LEAD = [["select", "Select"]];                                       // outermost last
  const TRAIL = [["bucket", "Counts as"], ["similar", "Similar"], ["tag", "Tag"]];
  const BTN = 80;            // each button's width, open
  const EDGE = 24;           // a drag from the screen's edge is the browser's back gesture
  const DECIDE = 8;          // px before deciding: a swipe, or a scroll
  const FULL = 0.6;          // past this share of the row, letting go does the outermost action
  let drag = null;           // the drag in progress
  let open = null;           // the row left open with its buttons showing: { txn, row, panel, x }
  let swallowUntil = 0;      // the click a drag (or a tap that closed a row) makes isn't a tap on a row

  const act = (txn, name) => feed.dispatchEvent(new CustomEvent("txnaction", { detail: { txn, act: name } }));
  const swallow = () => { swallowUntil = Date.now() + 400; };

  function panelFor(txn, row) {
    let p = txn.querySelector(":scope > .swipeacts");
    if (!p) {
      p = document.createElement("div");
      p.className = "swipeacts";
      p.setAttribute("aria-hidden", "true");                                  // the opened row's buttons are the accessible ones
      const b = ([a, label]) => `<button type="button" tabindex="-1" data-swipe="${a}">${label}</button>`;
      p.innerHTML = `<div class="lead">${LEAD.map(b).join("")}</div><div class="trail">${TRAIL.map(b).join("")}</div>`;
      txn.prepend(p);
    }
    p.style.height = `${row.offsetHeight}px`;
    return p;
  }
  function place(row, panel, x, animate) {
    row.classList.toggle("dragging", !animate);
    panel.classList.toggle("dragging", !animate);
    row.style.transform = x ? `translate3d(${x}px, 0, 0)` : "";
    panel.style.setProperty("--gap", `${Math.abs(x)}px`);
    panel.dataset.side = x > 0 ? "lead" : x < 0 ? "trail" : "";
  }
  // Moves a row to x (0: shut) and keeps track of it; a shut row's buttons go once it's back.
  function settle({ txn, row, panel }, x) {
    panel.classList.remove("full");
    place(row, panel, x, true);
    if (x) { open = { txn, row, panel, x }; return; }
    if (open?.row === row) open = null;
    setTimeout(() => { if (open?.txn !== txn && drag?.txn !== txn) panel.remove(); }, 300);
  }
  const close = () => { if (open) settle(open, 0); };

  // A tap anywhere while a row is open closes it, and does nothing else (as in Mail).
  document.addEventListener("pointerdown", (e) => {
    if (open && !open.row.isConnected) open = null;                          // the feed was redrawn
    if (!open || e.target.closest(".swipeacts") || e.target.closest(".row") === open.row) return;
    close();
    swallow();
  }, true);
  window.addEventListener("scroll", () => { if (open && !drag) close(); }, { passive: true });

  feed.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !e.isPrimary || document.body.classList.contains("selecting")) return;
    const row = e.target.closest(".txn > .row");
    if (!row || e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
    drag = { id: e.pointerId, txn: row.parentElement, row, x0: e.clientX, y0: e.clientY, base: open?.row === row ? open.x : 0, swiping: false, x: 0 };
  });
  feed.addEventListener("pointermove", (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.swiping) {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) { drag = null; return; }       // a scroll: the browser's
      d.swiping = true;
      if (open && open.row !== d.row) close();
      d.row.setPointerCapture?.(e.pointerId);
      d.panel = panelFor(d.txn, d.row);
      d.w = d.row.offsetWidth;
    }
    d.x = Math.max(-d.w, Math.min(d.w, d.base + dx));
    const full = Math.abs(d.x) > d.w * FULL;
    if (full && !d.panel.classList.contains("full") && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);   // a tick where letting go acts (Android)
    d.panel.classList.toggle("full", full);
    place(d.row, d.panel, d.x, false);
  });
  function end(e) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (!d.swiping) {                                                       // a tap on the open row shuts it
      if (d.base && e.type === "pointerup") { close(); swallow(); }
      return;
    }
    swallow();
    const side = d.x > 0 ? LEAD : TRAIL;
    if (e.type === "pointerup" && Math.abs(d.x) > d.w * FULL) {               // a full swipe: the outermost action
      settle(d, 0);
      act(d.txn, side[side.length - 1][0]);
      return;
    }
    const opened = side.length * BTN;
    const opening = Math.abs(d.x) > Math.abs(d.base) ? Math.abs(d.x) > 36 : Math.abs(d.x) > opened - 36;
    settle(d, opening && e.type === "pointerup" ? Math.sign(d.x) * opened : 0);
  }
  feed.addEventListener("pointerup", end);
  feed.addEventListener("pointercancel", end);

  feed.addEventListener("click", (e) => {
    const b = e.target.closest("[data-swipe]");
    if (b) {
      e.stopImmediatePropagation();
      const txn = b.closest(".txn");
      close();
      act(txn, b.dataset.swipe);
      return;
    }
    if (Date.now() < swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
})();
