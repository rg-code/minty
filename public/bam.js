// BAM, Balance of Award Miles & points (docs/bam.md), in a popup on the dashboard, opened from the
// BAM button (or /?bam): every miles and points balance in the household, grouped by currency,
// with the number and when it was last updated. Balances are typed in here; each update is a new
// reading, so a balance keeps its history. A native <dialog> in ABC's frame. Data: GET /points.
(function () {
  const dialog = document.getElementById("bam");
  if (!dialog) return;
  const main = document.getElementById("bamMain");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => Number(n).toLocaleString("en-US");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayYear = d => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
  const KINDS = [["bank", "Bank and card points"], ["airline", "Airlines"], ["hotel", "Hotels"], ["other", "Other"]];
  const STALE_DAYS = 90;                           // older readings are greyed, with "update?"

  let users = [], data = null;
  let adding = false, updating = null, editing = null;   // the add form; a balance's key; a reading's id
  const openHistory = new Set();

  async function load() {
    try {
      const [u, r] = await Promise.all([fetch("/users"), fetch("/points")]);
      if (u.ok) users = await u.json();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
      data = await r.json();
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load balances: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const days = d => Math.round((Date.parse(data.today) - Date.parse(d)) / 864e5);
  function ago(d) {
    const n = days(d);
    if (n <= 0) return "today";
    if (n === 1) return "yesterday";
    if (n < 60) return `${n} days ago`;
    const m = Math.round(n / 30.4);
    return m < 24 ? `${m} months ago` : `${Math.round(n / 365)} years ago`;
  }
  const keyOf = b => `${b.owner}|${b.program}|${b.account_hint ?? ""}`;
  const who = b => [users.length > 1 ? esc(users.find(u => u.key === b.owner)?.label ?? b.owner) : "", b.account_hint ? `••${esc(b.account_hint)}` : ""].filter(Boolean).join(" · ");

  function render() {
    const list = data.balances;
    let html = `<div class="bam-top">
      <div class="bam-sum">${list.length ? `${list.length} balance${list.length === 1 ? "" : "s"} in ${new Set(list.map(b => b.program)).size} currenc${new Set(list.map(b => b.program)).size === 1 ? "y" : "ies"} · last update ${ago(list.reduce((a, b) => (b.as_of > a ? b.as_of : a), "0000-00-00"))}` : "No balances yet."}</div>
      <button type="button" class="pill solid" data-act="add">+ Add a balance</button>
    </div>`;
    if (adding) html += formHtml(null, "new");
    if (!list.length && !adding) {
      html += `<p class="abc-msg">Add your first balance: pick the program, type the number from its site or your statement, and BAM keeps it here with the date.</p>`;
    }
    for (const [kind, label] of KINDS) {
      const ofKind = list.filter(b => (b.kind ?? "other") === kind);
      if (!ofKind.length) continue;
      html += `<h3>${label}</h3>`;
      const programs = [...new Set(ofKind.map(b => b.program))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      for (const p of programs) {
        const rows = ofKind.filter(b => b.program === p);
        const total = rows.reduce((s, b) => s + b.balance, 0);
        html += `<section class="bam-cur" aria-label="${esc(rows[0].name)}">
          <div class="bam-cur-head"><span class="bam-name">${esc(rows[0].name)}</span>${rows.length > 1 ? `<span class="bam-total">${num(total)} <small>${esc(rows[0].unit)} in all</small></span>` : ""}</div>` +
          rows.map(rowHtml).join("") + `</section>`;
      }
    }
    html += `<p class="bam-fine">BAM never signs in to a loyalty program and stores no logins: these are the balances you added, with the date each was correct. Programs are named as on their own sites (checked ${esc(data.checked)}).</p>`;
    main.innerHTML = html;
  }

  const nameOf = id => data.programs.find(p => p.id === id)?.name ?? id;

  function rowHtml(b) {
    const k = keyOf(b), stale = days(b.as_of) > STALE_DAYS;
    let html = `<div class="bam-row${stale ? " stale" : ""}">
      <div class="bam-main">
        <div class="bam-bal">${num(b.balance)} <small>${esc(b.unit)}</small></div>
        <div class="bam-meta">${who(b) ? `${who(b)} · ` : ""}as of ${dayYear(b.as_of)} · ${ago(b.as_of)}${b.history[0] && b.history[0].balance !== b.balance ? ` · <span class="${b.balance < b.history[0].balance ? "down" : "up"}">${b.balance > b.history[0].balance ? "+" : "−"}${num(Math.abs(b.balance - b.history[0].balance))}</span> since ${dayYear(b.history[0].as_of)}` : ""}${stale ? ` · <button type="button" class="bam-link" data-update="${esc(k)}">update?</button>` : ""}</div>
        <div class="bam-actions">
          <button type="button" data-update="${esc(k)}">Update</button>
          <button type="button" data-edit="${b.id}">Fix this one</button>
          ${b.history.length ? `<button type="button" data-hist="${esc(k)}" aria-expanded="${openHistory.has(k)}">History (${b.history.length})</button>` : ""}
          <button type="button" data-del="${b.id}">Delete</button>
        </div>
      </div>
    </div>`;
    if (updating === k) html += formHtml(b, "update");
    if (editing === b.id) html += formHtml(b, "edit");
    if (openHistory.has(k) && b.history.length) {
      html += `<table class="bam-history"><thead><tr><th>As of</th><th>Balance</th><th>Change</th><th></th></tr></thead><tbody>` +
        b.history.map((h, i) => {
          const older = b.history[i + 1], d = older ? h.balance - older.balance : null;   // since the reading before it
          const change = d === null ? "" : d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${num(Math.abs(d))}`;
          return `<tr><td>${dayYear(h.as_of)}</td><td>${num(h.balance)}</td><td class="${d < 0 ? "down" : d > 0 ? "up" : ""}">${change}</td><td><button type="button" class="bam-link" data-del="${h.id}">Delete</button></td></tr>`;
        }).join("") + `</tbody></table>`;
    }
    return html;
  }

  /** The add form ("new"), a new reading of a balance ("update"), or a correction of one ("edit"). */
  function formHtml(b, mode) {
    const opts = KINDS.filter(([k]) => k !== "other").map(([k, label]) =>
      `<optgroup label="${label}">${data.programs.filter(p => p.kind === k).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</optgroup>`).join("");
    const title = mode === "new" ? "Add a balance" : mode === "update" ? `Update ${esc(b.name)}` : `Fix this reading of ${esc(b.name)}`;
    const date = mode === "edit" ? b.as_of : data.today;
    const fixed = mode === "update";                // an update keeps the balance's program, person and account
    return `<form class="bam-form" data-form="${mode}"${b ? ` data-id="${b.id}"` : ""}>
      <h4>${title}</h4>
      ${fixed ? "" : `<label class="wide">Program<select name="program" required>${opts}<option value="__other">Another program (type its name)…</option></select></label>
      <label class="wide bam-other" hidden>Program name<input name="other" maxlength="40" placeholder="e.g. Alaska Mileage Plan"></label>`}
      ${!fixed && users.length > 1 ? `<label>Person<select name="owner">${users.map(u => `<option value="${esc(u.key)}">${esc(u.label)}</option>`).join("")}</select></label>` : ""}
      ${fixed ? "" : `<label>Last 4 digits <small>(optional)</small><input name="account_hint" inputmode="numeric" pattern="\\d{4}" maxlength="4" value="${esc(b?.account_hint ?? "")}"></label>`}
      <label>Balance<input name="balance" inputmode="numeric" required value="${mode === "edit" ? b.balance : ""}" placeholder="e.g. 65,536"></label>
      <label>As of<input name="as_of" type="date" required value="${esc(date)}" max="${esc(data.today)}"></label>
      <p class="bam-err" role="status"></p>
      <div class="bam-form-actions"><button type="submit" class="pill solid">Save</button><button type="button" class="pill" data-act="cancel">Cancel</button></div>
    </form>`;
  }

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    return r.json();
  }
  const whole = s => { const t = String(s).replace(/[,\s_]/g, ""); return /^\d+$/.test(t) ? Number(t) : null; };

  main.addEventListener("click", async e => {
    const t = e.target;
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "add") { adding = true; updating = editing = null; render(); main.querySelector('.bam-form select[name="program"]')?.focus(); return; }
    if (act === "cancel") { adding = false; updating = editing = null; render(); return; }
    const up = t.closest("[data-update]");
    if (up) { updating = up.dataset.update; adding = false; editing = null; render(); main.querySelector('.bam-form input[name="balance"]')?.focus(); return; }
    const ed = t.closest("[data-edit]");
    if (ed) { editing = Number(ed.dataset.edit); adding = false; updating = null; render(); return; }
    const h = t.closest("[data-hist]");
    if (h) { const k = h.dataset.hist; openHistory.has(k) ? openHistory.delete(k) : openHistory.add(k); render(); return; }
    const del = t.closest("[data-del]");
    if (del && confirm("Delete this reading?")) { try { await api("DELETE", `/points/${del.dataset.del}`); } catch (err) { alert(err.message); } return load(); }
  });

  main.addEventListener("change", e => {
    if (e.target.name === "program") {
      const other = e.target.form.querySelector(".bam-other");
      other.hidden = e.target.value !== "__other";
      other.querySelector("input").required = !other.hidden;
    }
  });

  main.addEventListener("submit", async e => {
    const form = e.target.closest("form.bam-form");
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const box = form.querySelector(".bam-err");
    const balance = whole(f.balance);
    if (balance === null) { box.textContent = "Type the balance as a whole number, like 65,536."; return; }
    const mode = form.dataset.form;
    const b = data.balances.find(x => keyOf(x) === updating) ?? data.balances.find(x => x.id === editing);
    const body = { balance, as_of: f.as_of };
    if (mode === "update") Object.assign(body, { program: b.program, owner: b.owner, account_hint: b.account_hint });
    else Object.assign(body, { program: f.program === "__other" ? f.other : f.program, account_hint: f.account_hint || null, ...(f.owner ? { owner: f.owner } : {}) });
    try {
      if (mode === "edit") await api("PUT", `/points/${form.dataset.id}`, body);
      else await api("POST", "/points", body);
      adding = false; updating = editing = null;
      load();
    } catch (err) { box.textContent = err.message; }
  });

  function open() {
    if (!dialog.open) dialog.showModal();
    load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-bam]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("bam")) open();
})();
