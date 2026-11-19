// Accounts (docs/accounts.md) in a popup on the dashboard, opened from the ⋯ menu (or /?accounts):
// every account, linked or entered by hand, grouped (cash, cards, loans, investments, retirement,
// other assets), with each group's total and net worth at the top, per person. Net worth follows
// CFA's rules (the server's in_net_worth): what's left out of the numbers isn't counted, only a home
// counts among other assets, and US dollars only. "Without home" leaves out the home and the
// mortgages and home equity loans against it. Manual accounts are added, updated and removed here;
// any account's holders and beneficiary are set here. A native <dialog> in ABC's frame.
// Data: GET /users, GET /accounts?view=all&manual=1&members=0.
(function () {
  const dialog = document.getElementById("accounts");
  if (!dialog) return;
  const main = document.getElementById("accountsMain");

  // The kinds a manual account can be: Plaid's own type and subtype, then a label. The server's
  // list is MANUAL_KINDS in src/routes/manual.ts (test/manual.test.ts checks they match).
  const KINDS = [
    ["Cash", [["depository", "checking", "Checking"], ["depository", "savings", "Savings"], ["depository", "cd", "CD"],
              ["depository", "money market", "Money market"], ["depository", "cash management", "Cash management"]]],
    ["Investments", [["investment", "brokerage", "Brokerage"], ["investment", "529", "529 plan"], ["investment", "education savings account", "Education savings (ESA)"],
                     ["investment", "ugma", "UGMA (custodial)"], ["investment", "utma", "UTMA (custodial)"], ["investment", "crypto exchange", "Crypto"],
                     ["investment", "other", "Other investment"]]],
    ["Retirement", [["investment", "401k", "401(k)"], ["investment", "403B", "403(b)"], ["investment", "457b", "457(b)"], ["investment", "roth 401k", "Roth 401(k)"],
                    ["investment", "ira", "IRA"], ["investment", "roth", "Roth IRA"], ["investment", "sep ira", "SEP IRA"], ["investment", "simple ira", "SIMPLE IRA"],
                    ["investment", "pension", "Pension"], ["investment", "hsa", "HSA"], ["investment", "retirement", "Other retirement"]]],
    ["Cards and loans", [["credit", "credit card", "Credit card"], ["loan", "mortgage", "Mortgage"], ["loan", "home equity", "Home equity loan"],
                         ["loan", "auto", "Auto loan"], ["loan", "student", "Student loan"], ["loan", "personal", "Personal loan"], ["loan", "other", "Other loan"]]],
    ["Other assets", [["other", "home", "Home"], ["other", "vehicle", "Vehicle"], ["other", "valuables", "Valuables"], ["other", "other", "Other asset"]]],
  ];
  const kindLabel = (t, s) => KINDS.flatMap(g => g[1]).find(k => k[0] === t && k[1] === s)?.[2] ?? (s || t || "");
  const GROUPS = [["cash", "Cash"], ["cards", "Cards"], ["loans", "Loans"], ["investments", "Investments"], ["retirement", "Retirement"], ["other", "Other assets"]];
  const groupOf = a => a.type === "depository" ? "cash" : a.type === "credit" ? "cards" : a.type === "loan" ? "loans"
    : a.in_retirement ? "retirement" : a.type === "investment" ? "investments" : "other";
  const isDebt = a => a.type === "credit" || a.type === "loan";
  const isHome = a => a.type === "other" && a.subtype === "home";
  const isHomeDebt = a => a.type === "loan" && (a.subtype === "mortgage" || a.subtype === "home equity");
  const STALE_DAYS = 90;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v, cur = "USD") => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD" }).format(v ?? 0); }
                                      catch { return `${cur} ${(v ?? 0).toFixed(2)}`; } };
  const localDay = () => new Date().toLocaleDateString("en-CA");                    // YYYY-MM-DD, the browser's own day
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => d ? `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : "";
  const ago = d => Math.round((Date.parse(localDay()) - Date.parse(d)) / 864e5);
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: not remembered */ } } };

  let users = [], accounts = null, person = "all", wide = false, noHome = store.get("minty.accounts.nohome") === "1", editing = null, err = "";

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    return d;
  }
  async function load() {
    try {
      const [u, a] = await Promise.all([api("GET", "/users"), api("GET", "/accounts?view=all&manual=1&members=0")]);
      users = u; accounts = a;
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load accounts: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const label = k => users.find(u => u.key === k)?.label ?? `${k} (not in MINTY_USERS)`;
  const names = ks => ks.map(label).join(" & ");
  const forWhom = b => b ? (b.key ? label(b.key) : b.name) : "";
  /** Whether account a shows for the person chosen: owned, or (the wider view) held by them or for them. */
  const mine = a => person === "all" || a.owner === person || (wide && ((a.holders || []).includes(person) || a.beneficiary?.key === person));
  /** Whether account a adds to the totals shown: counted in net worth, the person's own, and with or without the home. */
  const counted = a => !!a.in_net_worth && !a.left_out && (person === "all" || a.owner === person) && !(noHome && (isHome(a) || isHomeDebt(a)));
  const signed = a => (isDebt(a) ? -1 : 1) * (a.balance_current ?? 0);

  function render() {
    if (!accounts) return;
    const shown = accounts.filter(mine);
    const hasHome = accounts.some(a => isHome(a) || isHomeDebt(a));
    const hasRel = accounts.some(a => (a.holders || []).length || a.beneficiary);
    const worth = shown.filter(counted).reduce((t, a) => t + signed(a), 0);
    const foreign = shown.filter(a => (a.currency || "USD").toUpperCase() !== "USD");
    const seg = (cls, opts, cur) => `<div class="segpill acc-seg ${cls}" role="group">${opts.map(([k, l]) =>
      `<button type="button" data-v="${esc(k)}" aria-pressed="${k === cur}">${esc(l)}</button>`).join("")}</div>`;
    let html = `<div class="acc-top">
      <div><div class="acc-worth-label">${noHome ? "Net worth without home" : "Net worth"}${person !== "all" ? ` · ${esc(label(person))}` : ""}</div>
        <div class="acc-worth num">${esc(money(worth))}</div>
        ${foreign.length ? `<div class="acc-note">${foreign.length} account${foreign.length === 1 ? "" : "s"} in another currency (${esc([...new Set(foreign.map(a => a.currency))].join(", "))}) not included.</div>` : ""}</div>
      <div class="acc-ctls">
        ${users.length > 1 ? seg("acc-person", [["all", "Combined"], ...users.map(u => [u.key, u.label])], person) : ""}
        ${hasRel && person !== "all" ? seg("acc-wide", [["0", "Owned"], ["1", "Owned, held or for"]], wide ? "1" : "0") : ""}
        ${hasHome ? `<button type="button" class="pill acc-nohome" aria-pressed="${noHome}">Without home</button>` : ""}
      </div></div>`;
    if (err) html += `<div class="abc-msg abc-err">${esc(err)}</div>`;
    for (const [g, title] of GROUPS) {
      const list = shown.filter(a => groupOf(a) === g);
      if (!list.length) continue;
      const total = list.filter(counted).reduce((t, a) => t + (a.balance_current ?? 0), 0);
      html += `<section class="acc-group"><h3>${esc(title)}<span class="num">${list.some(counted) ? esc(money(total)) : ""}</span></h3>
        <ul>${list.map(row).join("")}</ul></section>`;
    }
    if (!shown.length) html += `<p class="acc-empty">No accounts${person !== "all" ? ` for ${esc(label(person))}` : ""} yet.</p>`;
    html += editing === "new" ? form(null) : `<button type="button" class="pill acc-add">+ Add an account by hand</button>`;
    html += `<p class="acc-fine">Net worth counts cash, investments, retirement and a home, less cards and loans, in US dollars.
      Other assets such as a vehicle show their value but aren't counted. Balances entered by hand are as of the date you give.</p>`;
    main.innerHTML = html;
  }

  function row(a) {
    const why = a.left_out ? "left out" : !a.in_net_worth ? ((a.currency || "USD").toUpperCase() !== "USD" ? `not in totals (${a.currency})` : "not in net worth")
      : noHome && (isHome(a) || isHomeDebt(a)) ? "not in Without home" : person !== "all" && a.owner !== person ? (a.beneficiary?.key === person ? `for ${label(person)}` : "held") : "";
    const rel = [(a.holders || []).length ? `Held by ${names(a.holders)}` : "", a.beneficiary ? `For ${forWhom(a.beneficiary)}` : ""].filter(Boolean).join(" · ");
    const when = a.is_manual ? (a.balance_as_of ? `as of ${day(a.balance_as_of)}` : "") : a.updated_at ? `updated ${day(a.updated_at.slice(0, 10))}` : "";
    const stale = a.is_manual && a.balance_as_of && ago(a.balance_as_of) > STALE_DAYS;
    const bal = a.balance_current === null || a.balance_current === undefined ? "—" : money(a.balance_current, a.currency);
    return `<li class="acc-row${why ? " acc-muted" : ""}" data-id="${a.id}">
      <button type="button" class="acc-open" aria-expanded="${editing === a.id}">
        <span class="acc-name">${esc(a.name || kindLabel(a.type, a.subtype))}${a.mask ? ` <span class="acc-mask">••${esc(a.mask)}</span>` : ""}</span>
        <span class="acc-bal num">${esc(bal)}</span>
        <span class="acc-meta">${esc(a.is_manual ? (a.bank || "Entered by hand") : (a.bank || "A bank"))}${users.length > 1 ? ` · ${esc(label(a.owner))}` : ""} · ${esc(kindLabel(a.type, a.subtype))}${rel ? ` · ${esc(rel)}` : ""}</span>
        <span class="acc-when${stale ? " acc-stale" : ""}">${esc(when)}${stale ? ` · ${Math.round(ago(a.balance_as_of) / 30)} months old` : ""}${why ? ` · ${esc(why)}` : ""}</span>
      </button>${editing === a.id ? form(a) : ""}</li>`;
  }

  /** The form: a manual account's every field (new or saved), or a linked account's holders and beneficiary. */
  function form(a) {
    const manual = !a || a.is_manual;
    const owner = a?.owner ?? (person !== "all" ? person : users[0]?.key);
    const b = a?.beneficiary;
    const people = users.map(u => `<label class="acc-check"><input type="checkbox" name="holder" value="${esc(u.key)}"${(a?.holders || []).includes(u.key) ? " checked" : ""} /> ${esc(u.label)}</label>`).join("");
    const benefit = `<label>For (beneficiary)<select name="ben"><option value="">No one</option>${users.map(u =>
        `<option value="key:${esc(u.key)}"${b?.key === u.key ? " selected" : ""}>${esc(u.label)}</option>`).join("")}<option value="name"${b?.name ? " selected" : ""}>Someone else…</option></select></label>
      <label class="acc-benname"${b?.name ? "" : " hidden"}>Their name<input name="benname" maxlength="100" value="${esc(b?.name ?? "")}" /></label>`;
    const kinds = KINDS.map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([t, s, l]) =>
      `<option value="${esc(t)}|${esc(s)}"${a && a.type === t && a.subtype === s ? " selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>`).join("");
    const debt = a ? isDebt(a) : false;
    return `<form class="acc-form" data-id="${a ? a.id : "new"}" novalidate>
      ${manual ? `<div class="acc-fields">
        <label>Name<input name="name" required maxlength="60" value="${esc(a?.name ?? "")}" placeholder="e.g. House" /></label>
        <label>Kind<select name="kind">${kinds}</select></label>
        <label><span class="acc-ballabel">${debt ? "Amount owed" : "Value"}</span><input name="balance" inputmode="decimal" value="${a?.balance_current ?? ""}" placeholder="0.00" /></label>
        <label>As of<input name="asof" type="date" max="${localDay()}" value="${esc(a?.balance_as_of ?? localDay())}" /></label>
        ${users.length > 1 ? `<label>Person<select name="owner">${users.map(u => `<option value="${esc(u.key)}"${u.key === owner ? " selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>` : ""}
        <label>Bank or source<input name="institution" maxlength="80" value="${esc(a?.bank ?? "")}" placeholder="optional" /></label>
        <label>Last 4<input name="mask" inputmode="numeric" maxlength="4" value="${esc(a?.mask ?? "")}" placeholder="optional" /></label>
        <label>Currency<input name="currency" maxlength="3" value="${esc(a?.currency ?? "USD")}" /></label>
        <label class="acc-wide">Notes<input name="notes" maxlength="1000" value="${esc(a?.notes ?? "")}" placeholder="optional, e.g. where the value comes from" /></label>
      </div>` : `<div class="acc-fields"><p class="acc-linked">Linked through ${esc(a.bank || "a bank")}: its balance comes from the bank. Who holds it and who it's for are yours to set.</p></div>`}
      <div class="acc-fields">${users.length ? `<div class="acc-holders"><span>Held by</span>${people}</div>` : ""}${benefit}</div>
      <div class="acc-buttons"><button type="submit" class="pill solid">Save</button><button type="button" class="pill acc-cancel">Cancel</button>
        ${a && a.is_manual ? `<button type="button" class="pill acc-remove">Remove…</button>` : ""}<span class="acc-formerr" role="alert"></span></div>
    </form>`;
  }

  function relationsOf(f) {
    const holders = [...f.querySelectorAll('input[name="holder"]:checked')].map(i => i.value);
    const v = f.elements.ben.value;
    const beneficiary = !v ? null : v === "name" ? (f.elements.benname.value.trim() ? { name: f.elements.benname.value.trim() } : null) : { key: v.slice(4) };
    return { holders, beneficiary };
  }
  async function save(f) {
    const id = f.dataset.id, a = accounts.find(x => String(x.id) === id);
    const errBox = f.querySelector(".acc-formerr");
    try {
      if (a && !a.is_manual) await api("PUT", `/accounts/${a.id}/holders`, relationsOf(f));
      else {
        const [type, subtype] = f.elements.kind.value.split("|");
        const raw = f.elements.balance.value.replace(/[$,\s]/g, "");
        if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new Error("Give the value as a number, e.g. 450000 or 1250.50");
        const body = { name: f.elements.name.value, type, subtype, balance_cents: Math.round(Number(raw) * 100), balance_as_of: f.elements.asof.value || localDay(),
                       institution: f.elements.institution.value, mask: f.elements.mask.value, currency: f.elements.currency.value || "USD",
                       notes: f.elements.notes.value, ...(f.elements.owner ? { owner: f.elements.owner.value } : { owner: users[0]?.key ?? "me" }), ...relationsOf(f) };
        if (a) await api("PUT", `/accounts/${a.id}/manual`, body); else await api("POST", "/accounts/manual", body);
      }
      editing = null; err = "";
      await load();
    } catch (e) { errBox.textContent = e.message; }
  }

  main.addEventListener("click", async e => {
    const t = e.target;
    const v = t.closest(".acc-seg button");
    if (v) {
      if (v.closest(".acc-person")) { person = v.dataset.v; if (person === "all") wide = false; }
      else wide = v.dataset.v === "1";
      render(); return;
    }
    if (t.closest(".acc-nohome")) { noHome = !noHome; store.set("minty.accounts.nohome", noHome ? "1" : "0"); render(); return; }
    if (t.closest(".acc-add")) { editing = "new"; render(); main.querySelector(".acc-form input")?.focus(); return; }
    if (t.closest(".acc-cancel")) { editing = null; render(); return; }
    if (t.closest(".acc-remove")) {
      const f = t.closest(".acc-form"), a = accounts.find(x => String(x.id) === f.dataset.id);
      if (!confirm(`Remove "${a.name}" and its balance history? This can't be undone.`)) return;
      try { await api("DELETE", `/accounts/${a.id}/manual`); editing = null; await load(); }
      catch (e2) { f.querySelector(".acc-formerr").textContent = e2.message; }
      return;
    }
    const open = t.closest(".acc-open");
    if (open) { const id = Number(open.closest(".acc-row").dataset.id); editing = editing === id ? null : id; render(); }
  });
  main.addEventListener("change", e => {
    const f = e.target.closest(".acc-form");
    if (!f) return;
    if (e.target.name === "ben") f.querySelector(".acc-benname").hidden = e.target.value !== "name";
    if (e.target.name === "kind") {
      const debt = /^(credit|loan)\|/.test(e.target.value);
      f.querySelector(".acc-ballabel").textContent = debt ? "Amount owed" : "Value";
    }
  });
  main.addEventListener("submit", e => { e.preventDefault(); save(e.target); });

  async function open() {
    if (!dialog.open) dialog.showModal();
    await load();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-accounts]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("accounts")) open();
})();
