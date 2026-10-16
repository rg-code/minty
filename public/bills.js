// Bills (docs/bills.md) in a popup on the dashboard, opened from the ⋯ menu (or /?bills): credit
// card statements by due date, whether each looks paid, balances and past statements. A native
// <dialog> like ABC's, closed by its × button, Esc or a click outside. Data: GET /bills.
(function () {
  const dialog = document.getElementById("bills");
  if (!dialog) return;
  const main = document.getElementById("billsMain");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => (c < 0 ? "−" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  const dayYear = d => `${day(d)}, ${d.slice(0, 4)}`;
  const RANGES = [[7, "7 days"], [14, "14 days"], [30, "30 days"], [0, "All"]];
  const STATUS = { paid: "Paid", partial: "Partly paid", unpaid: "Not paid yet", overdue: "Overdue", nothing_due: "Nothing due",
                   unknown: "Can't tell yet", no_statement: "" };
  const BANK_NOTE = {
    pending: "Statement details are on; the first ones arrive within about ten minutes.",
    consent_required: "needs your consent again for statement details.",
    unsupported: "doesn't share statement details through Plaid.",
    error: "Couldn't fetch statement details; Minty retries every hour.",
  };
  let users = [], data = null, range = 30;
  const open = new Set();                          // cards whose past statements are shown

  async function load() {
    main.innerHTML = `<div class="abc-msg">Loading…</div>`;
    try {
      const [u, r] = await Promise.all([fetch("/users"), fetch("/bills")]);
      if (u.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load bills: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const who = c => users.length > 1 ? ` · ${esc(users.find(u => u.key === c.owner)?.label ?? c.owner)}` : "";
  const title = c => `${esc(c.name || "Card")}${c.mask ? ` ••${esc(c.mask)}` : ""}`;
  const when = days => days === 0 ? "today" : days === 1 ? "tomorrow" : days < 0 ? `${-days} day${days === -1 ? "" : "s"} ago` : `in ${days} days`;

  function chip(c) {
    const s = c.latest;
    let text = STATUS[c.status] ?? c.status;
    if (c.status === "partial") text = `Partly paid: ${money(s.paid_cents)} of ${money(s.statement_cents)}`;
    return `<span class="bill-chip ${esc(c.status)}">${esc(text)}</span>`;
  }

  function cardRow(c) {
    const s = c.latest;
    const meta = [`Statement ${money(s.statement_cents ?? 0)}`];
    if (s.minimum_payment_cents) meta.push(`minimum ${money(s.minimum_payment_cents)}`);
    const due = s.due_date ? `Due ${dayYear(s.due_date)} (${when(c.days_left)})` : "No due date reported";
    const past = c.history.length
      ? `<button type="button" class="bill-more" data-card="${c.account_id}" aria-expanded="${open.has(c.account_id)}">${open.has(c.account_id) ? "Hide" : "Past"} statements (${c.history.length})</button>` : "";
    const history = open.has(c.account_id) ? `<table class="bill-history"><thead><tr><th>Closed</th><th>Amount</th><th>Due</th><th>Paid?</th></tr></thead><tbody>` +
      c.history.map(h => `<tr><td>${dayYear(h.issue_date)}</td><td>${money(h.statement_cents ?? 0)}</td><td>${h.due_date ? day(h.due_date) : "—"}</td>` +
        `<td><span class="bill-chip ${esc(h.status)}">${esc(STATUS[h.status] ?? h.status)}</span></td></tr>`).join("") + `</tbody></table>` : "";
    return `<div class="bill ${c.attention ? "attention" : ""}">
      <div class="bill-main">
        <div class="bill-name">${title(c)}<span class="bill-where">${esc(c.bank || "Bank")}${who(c)}</span></div>
        <div class="bill-meta">${due}. ${meta.join(", ")}. Closed ${day(s.issue_date)}.</div>
        <div class="bill-meta">Balance now ${money(c.balance_cents ?? 0)}${s.paid_cents ? `. Paid since the statement: ${money(s.paid_cents)}` : ""}.</div>
        ${c.reason ? `<div class="bill-meta bill-why">${esc(c.reason)}</div>` : ""}
        ${past}
      </div>
      ${chip(c)}
    </div>${history}`;
  }

  function render() {
    const d = data;
    const dated = d.cards.filter(c => c.latest);
    const inRange = c => !range || c.days_left === null || c.days_left <= range;
    const attention = dated.filter(c => c.attention);
    const due = dated.filter(c => !c.attention && inRange(c));
    const later = dated.filter(c => !c.attention && !inRange(c));
    const noStatement = d.cards.filter(c => !c.latest);
    const notes = d.banks.filter(b => BANK_NOTE[b.statements]);
    let html = `<div class="bill-ranges" role="group" aria-label="Due within">` +
      RANGES.map(([n, label]) => `<button type="button" data-range="${n}" aria-pressed="${n === range}">${label}</button>`).join("") + `</div>`;
    if (attention.length) html += `<h3 class="bill-h attention">Needs attention</h3><p class="bill-hint">Not paid, and due within ${d.attention_days} days or overdue.</p>` + attention.map(cardRow).join("");
    html += `<h3 class="bill-h">Due ${range ? `in the next ${range} days` : ""}</h3>` + (due.length ? due.map(cardRow).join("")
      : `<p class="bill-hint">${dated.length ? "Nothing else is due in this range." : "No card statements yet."}</p>`);
    if (later.length) html += `<h3 class="bill-h">Later</h3>` + later.map(cardRow).join("");
    if (notes.length) html += `<div class="bill-notes">` + notes.map(b => `<p>${b.statements === "pending" ? esc(BANK_NOTE.pending) + ` (${esc(b.bank || "Bank")})`
      : `${esc(b.bank || "A bank")} ${esc(BANK_NOTE[b.statements])}`} <a href="/connect#statements">Statement details</a></p>`).join("") + `</div>`;
    if (noStatement.length) {
      html += `<h3 class="bill-h">Cards without statement details</h3>` + noStatement.map(c => `<div class="bill quiet"><div class="bill-main">
        <div class="bill-name">${title(c)}<span class="bill-where">${esc(c.bank || "Bank")}${who(c)}</span></div>
        <div class="bill-meta">Balance now ${money(c.balance_cents ?? 0)}.</div></div></div>`).join("") +
        `<p class="bill-hint">To see their statements, due dates and whether they're paid, turn on <a href="/connect#statements">statement details</a> for their bank.</p>`;
    }
    html += `<p class="bill-fine">"Paid" is Minty's estimate from the payments posted to each card after its statement closed, and the bank's last payment. The bank's own records are what count.</p>`;
    main.innerHTML = html;
  }

  main.addEventListener("click", e => {
    const r = e.target.closest("[data-range]");
    if (r) { range = Number(r.dataset.range); render(); return; }
    const m = e.target.closest("button.bill-more");
    if (m) { const id = Number(m.dataset.card); open.has(id) ? open.delete(id) : open.add(id); render(); }
  });

  function show() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-bills]")) { e.preventDefault(); show(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("bills")) show();
})();
