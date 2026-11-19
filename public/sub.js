// SUB, sign-up bonuses (docs/sub.md), in a popup on the dashboard, opened from the ⋯ menu (or
// /?sub): each offer, what's left to do and by when, whether it paid out, and how long the account
// has to stay open. Spend and deposits are estimated from the linked account's own transactions
// (GET /sub); a credit that looks like the bonus is offered as the payout, recorded only when you
// say so. An offer's terms come from pasted text, a PDF (pdf.js, as Bills) or a screenshot (read on
// /sub-scan, which hands the text back through sessionStorage); public/sub-parse.js suggests the
// fields, each with the sentence it came from. Nothing is uploaded: only the text you keep and the
// file's SHA-256 are saved. It never says an account is safe to close. A native <dialog> in ABC's frame.
(function () {
  const dialog = document.getElementById("sub");
  if (!dialog) return;
  const main = document.getElementById("subMain");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => "$" + ((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: (c ?? 0) % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => d ? `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : "";
  const localDay = () => new Date().toLocaleDateString("en-CA");
  const daysTo = d => Math.round((Date.parse(d) - Date.parse(localDay())) / 864e5);
  const STATUS = [["planned", "Planned"], ["applied", "Applied"], ["open", "In progress"], ["met", "Requirements met"], ["paid", "Paid"], ["closed", "Closed"], ["lost", "Lost"]];
  const SECTIONS = [["In progress", ["open"]], ["Waiting for the payout", ["met"]], ["Paid: keep it open", ["paid"]], ["Planned and applied", ["planned", "applied"]], ["Closed", ["closed", "lost"]]];
  const REQ = { spend: "Spend", deposits: "Deposits", direct_deposits: "Direct deposits", balance: "Keep a balance", transactions: "Purchases", other: "Other" };
  const SCAN_KEY = "minty.sub.scan";

  let users = [], data = null, accounts = [], person = "all", editing = null, adding = null, read = null, err = "";
  // read: the terms being read into the open form: { text, sha, from, parsed }

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    return d;
  }
  async function load() {
    try {
      const [u, s, a] = await Promise.all([api("GET", "/users"), api("GET", `/sub?today=${localDay()}`), api("GET", "/accounts?view=all&manual=1&members=0")]);
      users = u; data = s; accounts = a;
    } catch (e) {
      main.innerHTML = `<div class="abc-msg abc-err">Couldn't load SUB: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  const label = k => users.find(u => u.key === k)?.label ?? k;
  const program = id => data.programs.find(p => p.id === id);
  const reward = o => o.reward_points ? `${o.reward_points.toLocaleString("en-US")} ${esc(program(o.reward_program)?.name ?? "points")}`
    : o.reward_cents ? money(o.reward_cents) : "Reward not set";
  const title = o => [o.institution, o.product].filter(Boolean).join(" ") || o.account_name || "An offer";

  function holdingHtml(o) {
    const h = o.holding;
    if (h.state === "until") return `<div class="sub-hold until"><b>Keep open until ${day(h.date)}</b> <span>${esc(h.basis)}${h.calculated && h.calculated !== h.date ? ` (the rule says ${day(h.calculated)})` : ""}</span></div>`;
    if (h.state === "reached") return `<div class="sub-hold reached"><b>Holding date reached: check the terms</b> <span>${day(h.date)}, ${esc(h.basis)}</span></div>`;
    return `<div class="sub-hold unknown"><b>Holding terms unknown</b> <span>${esc(h.why)}</span></div>`;
  }
  function reqHtml(o, r) {
    const p = r.progress;
    const target = [r.target_cents !== null ? money(r.target_cents) : "", r.target_count ? `${r.target_count}×` : ""].filter(Boolean).join(" · ");
    const pct = r.done_at ? 100 : p && p.target ? Math.max(0, Math.min(100, Math.round((p.done / p.target) * 100))) : p && p.target_count ? Math.min(100, Math.round((p.count / p.target_count) * 100)) : null;
    const state = { met: "Met", met_estimate: "Looks met (estimate)", overdue: "Past the deadline", cant_tell: "Can't tell yet: the bank's feed is behind",
                    open: r.deadline ? `${daysTo(r.deadline)} day${daysTo(r.deadline) === 1 ? "" : "s"} left` : "Open" }[r.state];
    const est = r.done_at ? `Marked done on ${day(r.done_at)}` : p && (r.kind === "spend" || r.kind === "deposits" || r.kind === "direct_deposits")
      ? `${money(p.done)}${p.target ? ` of ${money(p.target)}` : ""}${p.target_count ? ` · ${p.count} of ${p.target_count}` : ""} (estimate)${p.pending ? ` · ${money(p.pending)} pending` : ""}` : "";
    return `<li class="sub-req ${esc(r.state)}">
      <div class="sub-req-top"><span><b>${esc(REQ[r.kind])}</b>${target ? ` ${esc(target)}` : ""}${r.deadline ? ` by ${day(r.deadline)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</span>
        <span class="sub-state">${esc(state)}</span></div>
      ${pct !== null ? `<div class="sub-bar" role="img" aria-label="${pct}%"><i style="width:${pct}%"></i></div>` : ""}
      ${est ? `<div class="sub-est">${esc(est)}</div>` : ""}
      <div class="sub-req-act"><button type="button" class="abc-link" data-done="${r.id}" data-on="${r.done_at ? "0" : "1"}">${r.done_at ? "Not done" : "Mark done"}</button>
        <button type="button" class="abc-link" data-delreq="${r.id}">Remove</button></div></li>`;
  }

  function offerHtml(o) {
    const acc = data.accounts[o.account_id];
    const many = o.account_id && data.offers.filter(x => x.account_id === o.account_id && x.status !== "lost").length > 1;
    return `<article class="sub-offer" data-id="${o.id}">
      <header><div><h4>${esc(title(o))}</h4><div class="sub-meta">${users.length > 1 ? `${esc(label(o.owner))} · ` : ""}${o.account_name ? `${esc(o.account_name)}${o.account_mask ? ` ••${esc(o.account_mask)}` : ""}` : "No account linked yet"}${o.opened_date ? ` · opened ${day(o.opened_date)}` : ""}</div></div>
        <div class="sub-reward">${reward(o)}</div></header>
      ${o.requirements.length ? `<ul class="sub-reqs">${o.requirements.map(r => reqHtml(o, r)).join("")}</ul>` : `<p class="sub-muted">No requirements recorded.</p>`}
      ${o.payouts.length ? `<div class="sub-paid">Paid: ${o.payouts.map(p => `${[p.amount_cents !== null ? money(p.amount_cents) : "", p.points ? `${p.points.toLocaleString("en-US")} pts` : ""].filter(Boolean).join(" + ") || "amount unknown"}${p.date ? ` on ${day(p.date)}` : " (date unknown)"} <button type="button" class="abc-link" data-delpay="${p.id}" aria-label="Remove this payout">×</button>`).join(" · ")}</div>` : ""}
      ${o.payout_candidates.length ? `<div class="sub-cand">Looks like the bonus: ${o.payout_candidates.map(c => `<span>${esc(c.name)} ${money(-c.amount_cents)} on ${day(c.date)} <button type="button" class="pill" data-cand="${c.id}">Record as the payout</button></span>`).join(" ")}</div>` : ""}
      ${["open", "met", "paid", "closed"].includes(o.status) ? holdingHtml(o) : ""}
      ${many && acc ? `<div class="sub-acct">This account, across its offers: ${acc.state === "until" ? `keep open until ${day(acc.date)}` : acc.state === "reached" ? "holding dates reached: check the terms" : "holding terms unknown"}${acc.unknown ? ` (${acc.unknown} offer${acc.unknown === 1 ? "" : "s"} with no rule)` : ""}</div>` : ""}
      ${o.annual_fee_cents ? `<div class="sub-muted">Annual fee ${money(o.annual_fee_cents)}${o.fee_date ? ` on ${day(o.fee_date)}` : ""}</div>` : ""}
      <div class="sub-actions">
        <select data-status aria-label="Status">${STATUS.map(([k, l]) => `<option value="${k}"${o.status === k ? " selected" : ""}>${l}</option>`).join("")}</select>
        <button type="button" class="pill" data-edit="${o.id}">Edit</button>
        <button type="button" class="pill" data-addreq="${o.id}">+ Requirement</button>
        <button type="button" class="pill" data-addpay="${o.id}">+ Payout</button>
        ${o.terms_url ? `<a class="pill" href="${esc(o.terms_url)}" target="_blank" rel="noopener noreferrer">Terms ↗</a>` : ""}
      </div>
      ${adding?.offer === o.id ? childForm(o) : ""}
      ${editing === o.id ? offerForm(o) : ""}
    </article>`;
  }

  function childForm(o) {
    if (adding.kind === "req") return `<form class="sub-child" data-kind="req" data-offer="${o.id}">
      <label>Kind<select name="kind">${Object.entries(REQ).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" placeholder="e.g. 4000" /></label>
      <label>How many<input name="count" inputmode="numeric" placeholder="optional" /></label>
      <label>By<input name="deadline" type="date" /></label>
      <label class="wide">Note<input name="note" maxlength="300" placeholder="optional" /></label>
      <div class="sub-buttons"><button class="pill solid" type="submit">Add</button><button class="pill" type="button" data-cancel>Cancel</button><span class="sub-err" role="alert"></span></div></form>`;
    return `<form class="sub-child" data-kind="pay" data-offer="${o.id}">
      <label>Amount<input name="amount" inputmode="decimal" placeholder="$, if cash" /></label>
      <label>Points<input name="points" inputmode="numeric" placeholder="if points" /></label>
      <label>Date<input name="date" type="date" max="${localDay()}" /></label>
      <label class="wide">Note<input name="note" maxlength="300" placeholder="optional, e.g. first installment" /></label>
      <div class="sub-buttons"><button class="pill solid" type="submit">Add</button><button class="pill" type="button" data-cancel>Cancel</button><span class="sub-err" role="alert"></span></div></form>`;
  }

  /** The offer's form, with its terms: paste, a PDF or a screenshot, and the parser's suggestions. */
  function offerForm(o) {
    const v = k => esc(o?.[k] ?? "");
    const linkable = accounts.filter(a => ["credit", "depository", "investment"].includes(a.type));
    const sug = read?.parsed;
    return `<form class="sub-form" data-id="${o ? o.id : "new"}" novalidate>
      <div class="sub-fields">
        ${users.length > 1 ? `<label>Person<select name="owner">${users.map(u => `<option value="${esc(u.key)}"${(o?.owner ?? (person !== "all" ? person : users[0].key)) === u.key ? " selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>` : ""}
        <label>Bank or issuer<input name="institution" maxlength="80" value="${v("institution")}" placeholder="e.g. Chase" /></label>
        <label>Product<input name="product" maxlength="100" value="${v("product")}" placeholder="e.g. Sapphire Preferred" /></label>
        <label>Kind<select name="kind">${[["card", "Card"], ["bank", "Bank account"], ["brokerage", "Brokerage"], ["other", "Other"]].map(([k, l]) => `<option value="${k}"${(o?.kind ?? "card") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Account<select name="account_id"><option value="">Not linked yet</option>${linkable.map(a => `<option value="${a.id}"${o?.account_id === a.id ? " selected" : ""}>${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ""}${a.bank ? ` · ${esc(a.bank)}` : ""}</option>`).join("")}</select></label>
        <label>Opened<input name="opened_date" type="date" value="${v("opened_date")}" /></label>
        <label>Reward ($)<input name="reward" inputmode="decimal" value="${o?.reward_cents ? o.reward_cents / 100 : ""}" placeholder="cash" /></label>
        <label>or points<input name="reward_points" inputmode="numeric" value="${v("reward_points")}" placeholder="e.g. 60000" /></label>
        <label>Program<select name="reward_program"><option value="">—</option>${data.programs.map(p => `<option value="${esc(p.id)}"${o?.reward_program === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <label>Expected payout<input name="expected_payout_date" type="date" value="${v("expected_payout_date")}" /></label>
        <label>Annual fee ($)<input name="fee" inputmode="decimal" value="${o?.annual_fee_cents ? o.annual_fee_cents / 100 : ""}" /></label>
        <label>Keep open: from<select name="rule_trigger"><option value="">No rule</option>${[["opened", "opening"], ["first_payout", "the first payout"], ["last_payout", "the last payout"], ["date", "a date"]].map(([k, l]) => `<option value="${k}"${o?.rule_trigger === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>for<input name="rule_length" inputmode="numeric" value="${v("rule_length")}" placeholder="e.g. 6" /></label>
        <label>unit<select name="rule_unit">${[["months", "months"], ["days", "days"]].map(([k, l]) => `<option value="${k}"${(o?.rule_unit ?? "months") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Rule starts (if a date)<input name="rule_trigger_date" type="date" value="${v("rule_trigger_date")}" /></label>
        <label class="wide">The rule, in the terms' words<input name="rule_text" maxlength="1000" value="${v("rule_text")}" placeholder="optional" /></label>
        <label>Or keep open until<input name="keep_open_until" type="date" value="${v("keep_open_until")}" /></label>
        <label class="wide">Why that date (needed with it)<input name="keep_open_reason" maxlength="300" value="${v("keep_open_reason")}" /></label>
        <label class="wide">Link to the terms<input name="terms_url" maxlength="500" value="${v("terms_url")}" placeholder="https://…" /></label>
      </div>
      <fieldset class="sub-terms"><legend>The offer's terms</legend>
        <div class="sub-read"><button type="button" class="pill" data-pdf>Read a PDF</button><input type="file" accept="application/pdf,.pdf" data-pdffile hidden />
          <button type="button" class="pill" data-scan>Read a screenshot</button>
          <span class="sub-muted">Read on this device; only the text you keep is saved. On a phone, copying the text out of a screenshot and pasting it here is quickest.</span></div>
        <textarea name="terms_text" rows="5" maxlength="8000" placeholder="Paste the offer's terms here">${esc(read?.text ?? o?.terms_text ?? "")}</textarea>
        <div class="sub-read"><button type="button" class="pill" data-parse>Suggest the fields from the terms</button><span class="sub-muted" data-count></span></div>
        ${sug ? suggestionsHtml(sug) : ""}
      </fieldset>
      <label class="sub-notes">Notes<input name="notes" maxlength="2000" value="${v("notes")}" /></label>
      <div class="sub-buttons"><button type="submit" class="pill solid">Save</button><button type="button" class="pill" data-cancel>Cancel</button>
        ${o ? `<button type="button" class="pill" data-delete="${o.id}">Remove…</button>` : ""}<span class="sub-err" role="alert"></span></div>
    </form>`;
  }

  function suggestionsHtml(p) {
    const f = p.fields, rows = [];
    if (f.reward_points) rows.push(["reward", `${f.reward_points.toLocaleString("en-US")} points${f.reward_program ? ` (${esc(program(f.reward_program)?.name ?? "")})` : ""}`]);
    if (f.reward_cents) rows.push(["reward", money(f.reward_cents)]);
    for (const r of p.requirements) rows.push([r.kind === "spend" ? "spend" : "deposits", `${REQ[r.kind]} ${money(r.target_cents)}${r.target_count ? ` · ${r.target_count}×` : ""}${r.length ? ` within ${r.length} ${r.unit}` : ""}`]);
    if (f.rule_length) rows.push(["rule", `Keep open ${f.rule_length} ${f.rule_unit} after ${f.rule_trigger === "opened" ? "opening" : "the payout"}`]);
    if (f.annual_fee_cents !== undefined) rows.push(["fee", `Annual fee ${money(f.annual_fee_cents)}${f.fee_waived_first_year ? ", waived the first year" : ""}`]);
    if (f.institution) rows.push(["", `Issuer: ${esc(f.institution)}`]);
    if (!rows.length) return `<p class="sub-muted">Nothing recognisable in these terms: fill the fields in yourself.</p>`;
    return `<div class="sub-sug"><b>Found in the terms</b> (check each one):<ul>${rows.map(([k, t]) => `<li>${t}${k && p.quotes[k] ? `<q>${esc(p.quotes[k])}</q>` : ""}</li>`).join("")}</ul>
      <button type="button" class="pill solid" data-usesug>Use these</button></div>`;
  }

  function render() {
    if (!data) return;
    const mine = data.offers.filter(o => person === "all" || o.owner === person);
    let html = `<div class="sub-top"><div class="sub-sum">${mine.length ? `${mine.filter(o => o.status === "open").length} in progress · ${mine.filter(o => o.status === "met").length} waiting for a payout` : "No offers yet."}</div>
      <div class="sub-ctls">${users.length > 1 ? `<div class="segpill sub-person" role="group">${[["all", "Everyone"], ...users.map(u => [u.key, u.label])].map(([k, l]) => `<button type="button" data-person="${esc(k)}" aria-pressed="${person === k}">${esc(l)}</button>`).join("")}</div>` : ""}
        <button type="button" class="pill solid" data-new>+ Add an offer</button></div></div>`;
    if (err) html += `<div class="abc-msg abc-err">${esc(err)}</div>`;
    if (editing === "new") html += `<article class="sub-offer">${offerForm(null)}</article>`;
    for (const [name, statuses] of SECTIONS) {
      const list = mine.filter(o => statuses.includes(o.status));
      if (list.length) html += `<section class="sub-sec"><h3>${esc(name)}</h3>${list.map(offerHtml).join("")}</section>`;
    }
    html += `<p class="bill-fine">Spend and deposits are estimates from the account's own transactions: purchases less refunds, not payments, fees, interest or transfers. Issuers decide what counts. A holding date comes only from a rule you record, or a date you give; Minty never says an account is safe to close.</p>`;
    main.innerHTML = html;
  }

  // --- reading terms ---------------------------------------------------------------------------
  let parser = null, pdfRead = null;
  const parse = async text => { parser ??= import(new URL("sub-parse.js", document.baseURI).href); return (await parser).parseOffer(text); };
  const lib = () => (pdfRead ??= import(new URL("pdf-read.js", document.baseURI).href));
  const formOf = el => el.closest(".sub-form");
  async function readText(f, text, sha, from) {
    parser ??= import(new URL("sub-parse.js", document.baseURI).href);
    if (from !== "paste") text = (await parser).tidy(text);              // a PDF's or screenshot's text: ligatures, spacing
    read = { text, sha, from, parsed: await parse(text) };
    keepForm(f); render();
  }
  /** Keep what's typed in the open form across a render. */
  let draft = null;
  function keepForm(f) { draft = f ? Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, v])) : null; }
  function restore() {
    const f = main.querySelector(".sub-form");
    if (!f || !draft) return;
    for (const [k, v] of Object.entries(draft)) if (f.elements[k] && k !== "terms_text") f.elements[k].value = v;
  }

  async function applySuggestions(f) {
    const p = read.parsed, x = p.fields, set = (k, v) => { if (v !== undefined && v !== null && f.elements[k]) f.elements[k].value = v; };
    set("institution", x.institution); set("kind", x.kind);
    set("reward_points", x.reward_points); set("reward", x.reward_cents !== undefined ? x.reward_cents / 100 : undefined); set("reward_program", x.reward_program);
    set("rule_trigger", x.rule_trigger); set("rule_length", x.rule_length); set("rule_unit", x.rule_unit); set("rule_text", x.rule_text);
    set("fee", x.annual_fee_cents !== undefined ? x.annual_fee_cents / 100 : undefined);
    read.requirements = p.requirements;
    f.querySelector(".sub-sug").innerHTML = `<b>Filled in.</b> ${p.requirements.length ? `${p.requirements.length} requirement${p.requirements.length === 1 ? "" : "s"} will be added when you save.` : ""} Check the fields above, then save.`;
  }

  // --- saving ----------------------------------------------------------------------------------
  const cents = s => { const t = String(s ?? "").replace(/[$,\s]/g, ""); if (!t) return null; if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`"${s}" isn't an amount`); return Math.round(Number(t) * 100); };
  const whole = s => { const t = String(s ?? "").replace(/[,\s]/g, ""); if (!t) return null; if (!/^\d+$/.test(t)) throw new Error(`"${s}" isn't a whole number`); return Number(t); };
  async function saveOffer(f) {
    const e = f.elements, id = f.dataset.id;
    const box = f.querySelector(".sub-err");
    try {
      const body = { owner: e.owner ? e.owner.value : users[0]?.key ?? "me", institution: e.institution.value, product: e.product.value, kind: e.kind.value,
        account_id: e.account_id.value ? Number(e.account_id.value) : null, opened_date: e.opened_date.value || null,
        reward_cents: cents(e.reward.value), reward_points: whole(e.reward_points.value), reward_program: e.reward_program.value || null,
        expected_payout_date: e.expected_payout_date.value || null, annual_fee_cents: cents(e.fee.value),
        rule_trigger: e.rule_trigger.value || null, rule_length: e.rule_trigger.value ? whole(e.rule_length.value) : null, rule_unit: e.rule_trigger.value ? e.rule_unit.value : null,
        rule_trigger_date: e.rule_trigger_date.value || null, rule_text: e.rule_text.value, keep_open_until: e.keep_open_until.value || null,
        keep_open_reason: e.keep_open_reason.value, terms_url: e.terms_url.value, terms_text: e.terms_text.value, notes: e.notes.value,
        ...(read?.sha ? { terms_sha256: read.sha } : {}) };
      if (id === "new") body.status = body.account_id ? "open" : "applied";
      const saved = id === "new" ? await api("POST", "/sub/offers", body) : await api("PUT", `/sub/offers/${id}`, body);
      const offerId = id === "new" ? saved.id : Number(id);
      const opened = body.opened_date;
      for (const r of read?.requirements ?? []) {
        const deadline = opened && r.length ? (r.unit === "months" ? addMonths(opened, r.length) : addDaysIso(opened, r.length)) : null;
        await api("POST", "/sub/requirements", { offer_id: offerId, kind: r.kind, target_cents: r.target_cents ?? null, target_count: r.target_count ?? null, deadline });
      }
      editing = null; read = null; draft = null; err = "";
      await load();
    } catch (x) { box.textContent = x.message; }
  }
  // the same calendar rules as src/sub/rules.ts (months end on a shorter month's last day)
  function addMonths(d, n) {
    const t = new Date(`${d}T00:00:00Z`), y = t.getUTCFullYear(), m = t.getUTCMonth() + n;
    return new Date(Date.UTC(y, m, Math.min(t.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
  }
  const addDaysIso = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

  async function saveChild(f) {
    const e = f.elements, box = f.querySelector(".sub-err");
    try {
      if (f.dataset.kind === "req") await api("POST", "/sub/requirements", { offer_id: Number(f.dataset.offer), kind: e.kind.value, target_cents: cents(e.amount.value),
                                                                             target_count: whole(e.count.value), deadline: e.deadline.value || null, note: e.note.value });
      else await api("POST", "/sub/payouts", { offer_id: Number(f.dataset.offer), amount_cents: cents(e.amount.value), points: whole(e.points.value), date: e.date.value || null, note: e.note.value });
      adding = null; await load();
    } catch (x) { box.textContent = x.message; }
  }

  main.addEventListener("click", async ev => {
    const t = ev.target, b = sel => t.closest(sel);
    const offer = b(".sub-offer[data-id]"), oid = offer ? Number(offer.dataset.id) : null;
    try {
      if (b("[data-person]")) { person = b("[data-person]").dataset.person; render(); return; }
      if (b("[data-new]")) { editing = "new"; read = null; draft = null; render(); return; }
      if (b("[data-edit]")) { editing = oid; read = null; draft = null; render(); return; }
      if (b("[data-cancel]")) { editing = null; adding = null; read = null; draft = null; render(); return; }
      if (b("[data-addreq]")) { adding = { offer: oid, kind: "req" }; render(); return; }
      if (b("[data-addpay]")) { adding = { offer: oid, kind: "pay" }; render(); return; }
      if (b("[data-done]")) { const x = b("[data-done]"); await api("PUT", `/sub/requirements/${x.dataset.done}`, { done_at: x.dataset.on === "1" ? localDay() : null }); await load(); return; }
      if (b("[data-delreq]")) { if (confirm("Remove this requirement?")) { await api("DELETE", `/sub/requirements/${b("[data-delreq]").dataset.delreq}`); await load(); } return; }
      if (b("[data-delpay]")) { if (confirm("Remove this payout?")) { await api("DELETE", `/sub/payouts/${b("[data-delpay]").dataset.delpay}`); await load(); } return; }
      if (b("[data-cand]")) {
        const o = data.offers.find(x => x.id === oid), c = o.payout_candidates.find(x => x.id === Number(b("[data-cand]").dataset.cand));
        await api("POST", "/sub/payouts", { offer_id: oid, date: c.date, amount_cents: -c.amount_cents, transaction_id: c.id });
        await load(); return;
      }
      if (b("[data-delete]")) {
        if (!confirm("Remove this offer, its requirements and payouts? This can't be undone.")) return;
        await api("DELETE", `/sub/offers/${b("[data-delete]").dataset.delete}`); editing = null; await load(); return;
      }
      const f = formOf(t);
      if (b("[data-pdf]")) { f.querySelector("[data-pdffile]").click(); return; }
      if (b("[data-scan]")) {
        keepForm(f);
        try { sessionStorage.setItem(SCAN_KEY, JSON.stringify({ offer: f.dataset.id, draft, back: true })); } catch { /* private window: comes back without the draft */ }
        location.href = "/sub-scan"; return;
      }
      if (b("[data-parse]")) { await readText(f, f.elements.terms_text.value, read?.sha ?? null, "paste"); restore(); return; }
      if (b("[data-usesug]")) { await applySuggestions(f); return; }
    } catch (x) { err = x.message; render(); }
  });
  main.addEventListener("change", async ev => {
    const t = ev.target;
    if (t.matches("[data-status]")) {
      try { await api("PUT", `/sub/offers/${t.closest(".sub-offer").dataset.id}`, { status: t.value }); await load(); }
      catch (x) { err = x.message; render(); }
      return;
    }
    if (t.matches("[data-pdffile]") && t.files.length) {
      const f = formOf(t);
      const { readPdfs } = await lib();
      const { rows } = await readPdfs(t.files, { view: "sub", known: async () => [], parse: text => ({ text }), max: 1 });
      const r = rows[0];
      if (!r || r.error) { f.querySelector(".sub-err").textContent = r?.error ?? "Couldn't read this PDF"; return; }
      await readText(f, r.text, r.sha, "pdf"); restore();
    }
  });
  main.addEventListener("input", ev => {
    if (ev.target.name === "terms_text") { const n = ev.target.value.length; const c = formOf(ev.target)?.querySelector("[data-count]"); if (c) c.textContent = n > 7000 ? `${n.toLocaleString("en-US")} of 8,000 characters` : ""; }
  });
  main.addEventListener("submit", ev => { ev.preventDefault(); if (ev.target.matches(".sub-form")) saveOffer(ev.target); else saveChild(ev.target); });

  async function open() {
    if (!dialog.open) dialog.showModal();
    await load();
    // back from /sub-scan with a screenshot's text: the form it came from, with the text read
    let scan = null;
    try { scan = JSON.parse(sessionStorage.getItem(SCAN_KEY) ?? "null"); if (scan?.text !== undefined) sessionStorage.removeItem(SCAN_KEY); } catch {}
    if (scan?.text !== undefined && data) {
      editing = scan.offer === "new" ? "new" : Number(scan.offer);
      draft = scan.draft ?? null;
      render(); restore();                                  // the form as it was, then the screenshot's text read into it
      const f = main.querySelector(".sub-form");
      if (f) { await readText(f, scan.text, scan.sha ?? null, "screenshot"); restore(); }
    }
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-open-sub]")) { e.preventDefault(); open(); }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });   // a click on the backdrop
  if (new URLSearchParams(location.search).has("sub")) open();
})();
