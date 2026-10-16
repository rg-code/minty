// Bills (docs/bills.md) in a popup on the dashboard, opened from the ⋯ menu (or /?bills): a
// calendar of card statements, card payments due and the household's own bills. Select a day for
// its details: amounts, whether each looks paid, and, for your own bills, Mark paid / Edit / Delete
// and "+ Add a bill due this day". Bills can also be read from PDFs, in the browser (pdf.js); the
// PDFs never leave the device. A native <dialog> in ABC's frame. Data: GET /bills.
(function () {
  const dialog = document.getElementById("bills");
  if (!dialog) return;
  const main = document.getElementById("billsMain");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => (c < 0 ? "−" : "") + "$" + (Math.abs(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parse = d => new Date(d + "T00:00:00Z");
  const iso = t => t.toISOString().slice(0, 10);
  const addDays = (d, n) => iso(new Date(parse(d).getTime() + n * 864e5));
  const day = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  const dayYear = d => `${day(d)}, ${d.slice(0, 4)}`;
  const longDay = d => `${DOW[parse(d).getUTCDay()]}, ${dayYear(d)}`;
  const RANGES = [[7, "7 days"], [14, "14 days"], [30, "30 days"], [90, "90 days"]];
  const STATUS = { paid: "Paid", partial: "Partly paid", unpaid: "Not paid yet", overdue: "Overdue", nothing_due: "Nothing due", unknown: "Can't tell yet" };
  const ICON = { paid: "✓", nothing_due: "✓", partial: "◐", overdue: "!", unknown: "?", unpaid: "" };
  const BANK_NOTE = { pending: "statement details are on; the first ones arrive within about ten minutes.",
                      consent_required: "needs your consent again for statement details.",
                      unsupported: "doesn't share statement details through Plaid.",
                      error: "statement details couldn't be fetched; Minty retries every hour." };

  let users = [], data = null, range = 30, selected = null;
  const show = { statements: true, due: true };
  let editing = null;                              // bill id being edited, or "new"
  let review = null;                               // PDFs read, waiting to be saved

  async function load() {
    try {
      const [u, r] = await Promise.all([fetch("/users"), fetch("/bills")]);
      if (u.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load bills: ${esc(e.message)}</div>`;
      return;
    }
    selected ??= data.today;
    render();
  }

  const person = k => users.length > 1 ? esc(users.find(u => u.key === k)?.label ?? k) : "";
  const short = c => `${esc((c.name || "Card").replace(/\s*(Card|card)\b.*$/, "").replace(/[®℠™]/g, "").trim() || c.name)}${c.mask ? ` ••${esc(c.mask)}` : ""}`;

  /** A card's next statement dates after its last one, up to `end`: the same day of the month,
   * or the typical gap between its statements when they don't fall on one. */
  function nextStatements(c, end) {
    const dates = [c.latest.issue_date, ...c.history.map(h => h.issue_date)].sort();
    const out = [];
    const last = parse(dates.at(-1));
    for (let k = 1; k <= 4; k++) {
      const t = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + k, 1));
      const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      t.setUTCDate(Math.min(last.getUTCDate(), dim));
      const d = iso(t);
      if (d > end) break;
      out.push(d);
    }
    return out;
  }

  /** Everything on the calendar between `from` and `to`, by date. */
  function events(from, to) {
    const out = [];
    for (const c of data.cards) {
      if (!c.latest) continue;
      if (c.latest.due_date && c.latest.due_date >= from && c.latest.due_date <= to) {
        out.push({ kind: "due", date: c.latest.due_date, card: c, name: short(c), sub: "Payment due", status: c.status, attention: c.attention,
                   amount: c.latest.statement_cents, who: c.owner });
      }
      for (const d of nextStatements(c, to)) if (d >= from) out.push({ kind: "statement", date: d, card: c, name: short(c), sub: "Estimated statement", who: c.owner });
    }
    for (const b of data.bills) {
      if (b.due_date >= from && b.due_date <= to) {
        out.push({ kind: "due", date: b.due_date, bill: b, name: esc(b.biller), sub: "Bill due", status: b.status, attention: b.attention, amount: b.amount_cents, who: b.owner });
      }
    }
    return out.filter(e => show[e.kind === "statement" ? "statements" : "due"]);
  }

  function attentionList() {
    const items = [
      ...data.cards.filter(c => c.attention).map(c => ({ date: c.latest.due_date, html: `${short(c)} · ${money(c.latest.statement_cents)} ${c.status === "overdue" ? "overdue" : `due ${dueIn(c.days_left)}`}` })),
      ...data.bills.filter(b => b.attention).map(b => ({ date: b.due_date, html: `${esc(b.biller)} · ${money(b.amount_cents)} ${b.status === "overdue" ? "overdue" : `due ${dueIn(b.days_left)}`}` })),
    ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    if (!items.length) return "";
    return `<div class="bill-attention" role="group" aria-label="Needs attention"><strong>Needs attention</strong>` +
      items.map(i => `<button type="button" class="bill-att" data-day="${esc(i.date)}">${i.html}</button>`).join("") +
      `<span class="bill-hint">Not paid, and due within ${data.attention_days} days or overdue.</span></div>`;
  }
  const dueIn = n => n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;

  function render() {
    const today = data.today, end = addDays(today, range);
    const start = addDays(today, -parse(today).getUTCDay());                 // the Sunday of this week
    const last = addDays(end, 6 - parse(end).getUTCDay());                   // the Saturday of the end's week
    const evs = events(start, last);
    const byDay = new Map();
    for (const e of evs) (byDay.get(e.date) ?? byDay.set(e.date, []).get(e.date)).push(e);
    const ahead = evs.filter(e => e.date >= today && e.date <= end);
    const nStat = ahead.filter(e => e.kind === "statement").length, nDue = ahead.filter(e => e.kind === "due").length;

    let html = `<div class="bill-top">
      <div class="bill-sum">Today through ${dayYear(end)} · ${nStat} statement date${nStat === 1 ? "" : "s"} · ${nDue} due date${nDue === 1 ? "" : "s"}</div>
      <div class="bill-actions">
        <button type="button" class="pill" data-act="add">+ Add a bill</button>
        <button type="button" class="pill" data-act="pdf">Add from PDFs</button>
        <button type="button" class="pill bill-folder" data-act="folder">Add a folder</button>
      </div>
    </div>
    <div class="bill-controls">
      <button type="button" class="bill-toggle statement" data-show="statements" aria-pressed="${show.statements}">Statements</button>
      <button type="button" class="bill-toggle due" data-show="due" aria-pressed="${show.due}">Payments &amp; bills</button>
      <div class="bill-ranges" role="group" aria-label="How far ahead">` +
        RANGES.map(([n, l]) => `<button type="button" data-range="${n}" aria-pressed="${n === range}">${l}</button>`).join("") + `</div>
    </div>`;
    html += attentionList();
    if (review) html += reviewHtml();
    html += `<div class="cal" role="grid" aria-label="Statements and due dates">` + DOW.map(d => `<div class="cal-dow" role="columnheader">${d}</div>`).join("");
    for (let d = start; d <= last; d = addDays(d, 1)) {
      const items = byDay.get(d) ?? [];
      const past = d < today, out = d > end;
      const label = d === today || d.endsWith("-01") || d === start ? ` <span class="cal-mon">${MON[Number(d.slice(5, 7)) - 1]}</span>` : "";
      html += `<button type="button" role="gridcell" class="cal-day${d === today ? " today" : ""}${d === selected ? " sel" : ""}${past ? " past" : ""}${out ? " out" : ""}" data-day="${d}" aria-label="${longDay(d)}: ${items.length} item${items.length === 1 ? "" : "s"}">
        <span class="cal-n">${Number(d.slice(8, 10))}${label}</span>` +
        items.slice(0, 3).map(e => `<span class="cal-ev ${e.kind}${e.attention ? " attention" : ""}"><b>${ICON[e.status] ? `<i class="cal-ic ${esc(e.status)}">${ICON[e.status]}</i>` : ""}${e.name}</b><small>${e.sub}</small></span>`).join("") +
        (items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : "") +
        `<span class="cal-dots" aria-hidden="true">${items.map(e => `<i class="${e.kind}${e.attention ? " attention" : ""}"></i>`).join("")}</span>
      </button>`;
    }
    html += `</div>`;
    html += detailsHtml(byDay.get(selected) ?? [], selected);
    const notes = data.banks.filter(b => BANK_NOTE[b.statements]);
    if (notes.length) html += `<div class="bill-notes">` + notes.map(b => `<p>${esc(b.bank || "A bank")}: ${esc(BANK_NOTE[b.statements])} <a href="/connect#statements">Statement details</a></p>`).join("") + `</div>`;
    const off = data.cards.filter(c => !c.latest);
    if (off.length) html += `<p class="bill-hint">${off.length} card${off.length === 1 ? " has" : "s have"} no statement details (${off.map(short).join(", ")}). <a href="/connect#statements">Turn them on</a> to see statements, due dates and whether they're paid.</p>`;
    html += `<p class="bill-fine">Statement dates ahead are estimates from each card's past statements. "Paid" is Minty's estimate from the payments posted after a statement or bill; the bank's or biller's own records are what count.</p>`;
    html += `<input type="file" id="billPdfs" accept="application/pdf,.pdf" multiple hidden><input type="file" id="billFolder" webkitdirectory multiple hidden>`;
    main.innerHTML = html;
  }

  function detailsHtml(items, d) {
    if (!d) return "";
    let html = `<section class="bill-day" aria-label="${longDay(d)}"><h3>${longDay(d)}</h3>`;
    if (!items.length) html += `<p class="bill-hint">Nothing on this day.</p>`;
    for (const e of items) {
      if (e.kind === "statement") {
        html += `<div class="bill statement"><div class="bill-main"><div class="bill-name">${e.name}<span class="bill-where">${esc(e.card.bank || "")}${person(e.who) ? " · " + person(e.who) : ""}</span></div>
          <div class="bill-meta">Estimated statement date (last one closed ${day(e.card.latest.issue_date)} for ${money(e.card.latest.statement_cents)}). Balance now ${money(e.card.balance_cents)}.</div></div></div>`;
      } else if (e.card) {
        const c = e.card, s = c.latest;
        const chip = c.status === "partial" ? `Partly paid: ${money(s.paid_cents)} of ${money(s.statement_cents)}` : STATUS[c.status] ?? c.status;
        html += `<div class="bill due${c.attention ? " attention" : ""}"><div class="bill-main"><div class="bill-name">${e.name}<span class="bill-where">${esc(c.bank || "")}${person(c.owner) ? " · " + person(c.owner) : ""}</span></div>
          <div class="bill-meta">Payment due: statement ${money(s.statement_cents)}${s.minimum_payment_cents ? `, minimum ${money(s.minimum_payment_cents)}` : ""}. Closed ${day(s.issue_date)}.</div>
          <div class="bill-meta">Balance now ${money(c.balance_cents)}${s.paid_cents ? `. Paid since the statement: ${money(s.paid_cents)}` : ""}.</div>
          ${c.reason ? `<div class="bill-meta bill-why">${esc(c.reason)}</div>` : ""}
          ${c.history.length ? `<details class="bill-past"><summary>Past statements (${c.history.length})</summary><table class="bill-history"><thead><tr><th>Closed</th><th>Amount</th><th>Due</th><th>Paid?</th></tr></thead><tbody>` +
            c.history.map(h => `<tr><td>${dayYear(h.issue_date)}</td><td>${money(h.statement_cents)}</td><td>${h.due_date ? day(h.due_date) : "—"}</td><td><span class="bill-chip ${esc(h.status)}">${esc(STATUS[h.status] ?? h.status)}</span></td></tr>`).join("") +
            `</tbody></table></details>` : ""}</div>
          <span class="bill-chip ${esc(c.status)}">${esc(chip)}</span></div>`;
      } else {
        const b = e.bill;
        if (editing === b.id) { html += formHtml(b); continue; }
        const how = b.paid_how === "matched" ? `Paid ${day(b.matched.date)}: ${esc(b.matched.name)} ${money(b.matched.amount_cents)}` : b.paid_how === "marked" ? "Marked paid" : STATUS[b.status] ?? b.status;
        html += `<div class="bill due${b.attention ? " attention" : ""}"><div class="bill-main"><div class="bill-name">${esc(b.biller)}<span class="bill-where">${person(b.owner)}${b.account_hint ? ` · account ••${esc(b.account_hint)}` : ""}</span></div>
          <div class="bill-meta">Bill due: ${money(b.amount_cents)}${b.statement_date ? `. Billed ${day(b.statement_date)}` : ""}${b.source === "pdf" ? " (from a PDF)" : ""}.</div>
          <div class="bill-row-actions">
            ${b.paid_how !== "matched" ? `<button type="button" data-paid="${b.id}" data-to="${b.paid_at ? "false" : "true"}">${b.paid_at ? "Mark not paid" : "Mark paid"}</button>` : ""}
            <button type="button" data-edit="${b.id}">Edit</button>
            <button type="button" data-del="${b.id}">Delete</button>
          </div></div>
          <span class="bill-chip ${esc(b.status)}">${esc(how)}</span></div>`;
      }
    }
    html += editing === "new" ? formHtml(null) : `<button type="button" class="bill-add" data-act="add">+ Add a bill due this day</button>`;
    return html + `</section>`;
  }

  const personSelect = (name, value) => users.length > 1
    ? `<label>Person<select name="${name}">${users.map(u => `<option value="${esc(u.key)}" ${u.key === value ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>` : "";

  function formHtml(b) {
    const v = b ?? { biller: "", amount_cents: null, due_date: selected, statement_date: "", owner: users[0]?.key, match_name: "" };
    return `<form class="bill-form" data-form="${b ? b.id : "new"}">
      <h4>${b ? "Edit bill" : "Add a bill"}</h4>
      <label>Biller<input name="biller" required maxlength="80" value="${esc(v.biller)}" placeholder="PG&amp;E"></label>
      <label>Amount<input name="amount" required inputmode="decimal" value="${v.amount_cents === null ? "" : (v.amount_cents / 100).toFixed(2)}" placeholder="0.00"></label>
      <label>Due date<input name="due_date" type="date" required value="${esc(v.due_date)}"></label>
      <label>Bill date<input name="statement_date" type="date" value="${esc(v.statement_date ?? "")}"></label>
      ${personSelect("owner", v.owner)}
      <label class="wide">Its payment is called <input name="match_name" maxlength="40" value="${esc(v.match_name)}" placeholder="the biller's first word, e.g. PG&amp;E"></label>
      <p class="bill-err" role="status"></p>
      <div class="bill-form-actions"><button type="submit" class="pill solid">Save</button><button type="button" class="pill" data-act="cancel">Cancel</button></div>
    </form>`;
  }

  function reviewHtml() {
    const rows = review.rows;
    return `<section class="bill-review" aria-label="Bills read from PDFs"><h3>From your PDFs</h3>
      <p class="bill-hint">Check each one, then save. The PDFs stay on this device; only these fields are saved.</p>
      <table><thead><tr><th></th><th>File</th><th>Biller</th><th>Amount</th><th>Due</th><th>Bill date</th>${users.length > 1 ? "<th>Person</th>" : ""}</tr></thead><tbody>` +
      rows.map((r, i) => `<tr class="${r.known ? "known" : ""}${r.error ? " err" : ""}" data-row="${i}">
        <td><input type="checkbox" name="on" ${r.on ? "checked" : ""} ${r.known || r.error ? "disabled" : ""} aria-label="Save ${esc(r.file)}"></td>
        <td class="file">${esc(r.file)}${r.known ? "<small>Already added</small>" : r.error ? `<small>${esc(r.error)}</small>` : ""}</td>
        <td><input name="biller" value="${esc(r.biller ?? "")}" maxlength="80"></td>
        <td><input name="amount" inputmode="decimal" value="${r.amount_cents === null ? "" : (r.amount_cents / 100).toFixed(2)}" size="7"></td>
        <td><input name="due_date" type="date" value="${esc(r.due_date ?? "")}"></td>
        <td><input name="statement_date" type="date" value="${esc(r.statement_date ?? "")}"></td>
        ${users.length > 1 ? `<td><select name="owner">${users.map(u => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join("")}</select></td>` : ""}
      </tr>`).join("") + `</tbody></table>
      <p class="bill-err" role="status"></p>
      <div class="bill-form-actions"><button type="button" class="pill solid" data-act="save-review">Save ${rows.filter(r => r.on).length || ""} bill${rows.filter(r => r.on).length === 1 ? "" : "s"}</button><button type="button" class="pill" data-act="cancel-review">Cancel</button></div>
    </section>`;
  }

  const cents = s => { const n = Number(String(s).replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  }

  async function readPdfs(files) {
    const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf").slice(0, 50);
    if (!pdfs.length) { alert("No PDFs there."); return; }
    review = { rows: pdfs.map(f => ({ file: f.name, on: false, biller: "Reading…", amount_cents: null, due_date: null, statement_date: null })) };
    render();
    const base = document.baseURI;
    const pdfjs = await import(new URL("vendor/pdfjs/pdf.min.mjs", base).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", base).href;
    const { parseBill } = await import(new URL("bill-parse.js", base).href);
    const rows = [];
    for (const f of pdfs) {
      try {
        const buf = await f.arrayBuffer();
        const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
        let text = "";
        for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
          const content = await (await doc.getPage(p)).getTextContent();
          text += content.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
        }
        rows.push({ file: f.name, sha, ...parseBill(text, f.name), on: true });
      } catch {
        rows.push({ file: f.name, error: "Couldn't read this PDF", on: false });
      }
    }
    try {
      const { known } = await api("POST", "/bills/known", { sha256: rows.filter(r => r.sha).map(r => r.sha) });
      for (const r of rows) if (known.includes(r.sha)) { r.known = true; r.on = false; }
    } catch {}
    review = { rows };
    render();
  }

  main.addEventListener("click", async e => {
    const t = e.target;
    const dayBtn = t.closest("[data-day]");
    if (dayBtn) { selected = dayBtn.dataset.day; editing = null; render(); main.querySelector(".bill-day")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    const r = t.closest("[data-range]"); if (r) { range = Number(r.dataset.range); render(); return; }
    const s = t.closest("[data-show]"); if (s) { show[s.dataset.show] = !show[s.dataset.show]; render(); return; }
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "add") { editing = "new"; render(); main.querySelector('.bill-form input[name="biller"]')?.focus(); return; }
    if (act === "cancel") { editing = null; render(); return; }
    if (act === "pdf") { main.querySelector("#billPdfs").click(); return; }
    if (act === "folder") { main.querySelector("#billFolder").click(); return; }
    if (act === "cancel-review") { review = null; render(); return; }
    if (act === "save-review") return saveReview();
    const edit = t.closest("[data-edit]"); if (edit) { editing = Number(edit.dataset.edit); render(); return; }
    const paid = t.closest("[data-paid]");
    if (paid) { try { await api("POST", `/bills/${paid.dataset.paid}/paid`, { paid: paid.dataset.to === "true" }); } catch (err) { alert(err.message); } return load(); }
    const del = t.closest("[data-del]");
    if (del && confirm("Delete this bill?")) { try { await api("DELETE", `/bills/${del.dataset.del}`); } catch (err) { alert(err.message); } return load(); }
  });

  main.addEventListener("change", e => {
    if (e.target.id === "billPdfs" || e.target.id === "billFolder") { readPdfs(e.target.files); e.target.value = ""; return; }
    const row = e.target.closest("tr[data-row]");
    if (row && review) {
      const r = review.rows[Number(row.dataset.row)], f = e.target;
      if (f.name === "on") r.on = f.checked;
      else if (f.name === "amount") r.amount_cents = cents(f.value);
      else r[f.name] = f.value;
      if (f.name === "on") render();
    }
  });

  main.addEventListener("submit", async e => {
    const form = e.target.closest("form.bill-form");
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = { biller: f.biller, amount_cents: cents(f.amount), due_date: f.due_date, statement_date: f.statement_date || null,
                   ...(f.owner ? { owner: f.owner } : {}), ...(f.match_name ? { match_name: f.match_name } : {}) };
    try {
      if (form.dataset.form === "new") await api("POST", "/bills", body);
      else await api("PUT", `/bills/${form.dataset.form}`, body);
      editing = null; selected = body.due_date;
      load();
    } catch (err) { form.querySelector(".bill-err").textContent = err.message; }
  });

  async function saveReview() {
    const box = main.querySelector(".bill-review .bill-err");
    const rows = review.rows.filter(r => r.on);
    const bad = rows.find(r => !r.biller || r.amount_cents === null || !r.due_date);
    if (bad) { box.textContent = `${bad.file}: fill in the biller, amount and due date (or untick it).`; return; }
    let saved = 0;
    for (const r of rows) {
      try {
        await api("POST", "/bills", { biller: r.biller, amount_cents: r.amount_cents, due_date: r.due_date, statement_date: r.statement_date || null,
                                      account_hint: r.account_hint || null, source: "pdf", file_sha256: r.sha, ...(r.owner ? { owner: r.owner } : {}) });
        saved++; r.on = false; r.known = true;
      } catch (err) { box.textContent = `${r.file}: ${err.message}`; render(); return; }
    }
    review = null;
    if (rows[0]) selected = rows[0].due_date;
    await load();
    main.querySelector(".bill-sum")?.insertAdjacentHTML("beforeend", ` · <b>${saved} bill${saved === 1 ? "" : "s"} saved</b>`);
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-bills]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("bills")) open();
})();
