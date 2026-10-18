let USERS = null;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const color = i => `var(--u${i % 6})`;
let keyEdited = false;
let forUser = null;                                // an existing person whose keys aren't set yet (their "Add keys")

async function loadStatus() {
  let st = null;
  try { const r = await fetch("/status"); if (r.ok) st = await r.json(); } catch {}
  if (!st) return;
  $("checksTitle").hidden = false;
  $("checks").hidden = false;
  $("checks").innerHTML = st.checks.map(c => `<li class="${c.ok ? "ok" : c.level}">
      <span class="mark">${c.ok ? "✓" : c.level === "error" ? "✕" : "!"}</span><span>${esc(c.message)}</span>
      ${!c.ok && c.fix ? `<span class="fix">${esc(c.fix)}</span>` : ""}</li>`).join("");
}

// The device lock (lock.js): Face ID / fingerprint / screen lock before Minty shows anything here.
async function loadLock() {
  const el = $("lockState");
  if (!window.MintyLock) { el.textContent = "The device lock isn't available on this page."; return; }
  const st = await MintyLock.status();
  const say = {
    on: "Minty asks for Face ID, your fingerprint or the screen lock before it shows anything on this device.",
    off: "Minty isn't locked on this device.",
    unset: "Minty isn't locked on this device.",
    unavailable: "This device has no Face ID, fingerprint or screen-lock sign-in, so Minty isn't locked here.",
  }[st];
  const action = st === "on" ? "Turn off" : st === "unavailable" ? null : "Turn on";
  el.innerHTML = `${esc(say)}${action ? ` <button type="button" id="lockToggle">${action}</button>` : ""}`;
  $("lockToggle")?.addEventListener("click", async () => {
    try { await (st === "on" ? MintyLock.turnOff() : MintyLock.turnOn()); }
    catch { el.insertAdjacentHTML("beforeend", ' <span class="lockerr">That didn\u2019t work. Try again.</span>'); return; }
    loadLock();
  });
}

async function loadUsers() {
  try {
    const r = await fetch("/users");
    // show the API's reason (e.g. which Access setting to check), not just "failed"
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail || `HTTP ${r.status}`);
    USERS = await r.json();
    $("users").innerHTML = USERS.map((u, i) => `<li>
      <span class="dot" style="background:${color(i)}"></span>${esc(u.label)} <span class="key">${esc(u.key)}</span>
      <span class="slots">${u.slots.map(s =>
        `<span class="slot ${s.configured ? "yes" : "no"}">${esc(s.slot)} ${s.configured ? "✓" : "not set"}</span>`).join("")}</span>
      ${u.slots.some(s => s.configured) ? "" : `<button type="button" class="addkeys" data-addkeys="${esc(u.key)}">Add keys</button>`}
    </li>`).join("");
  } catch (e) {
    $("users").innerHTML = `<li>Couldn't load users from the Minty API: ${esc(e.message)}</li>`;
  }
  update();
}

// "Alex Smith" -> "alexsmith": lowercase letters/digits, starting with a letter.
const suggestKey = name => name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 24);

function validate(label, key) {
  if (!label) return "";
  if (/[,:]/.test(label)) return "Name can't contain a comma or colon.";
  if (!/^[a-z][a-z0-9]{0,23}$/.test(key)) return "Key must be lowercase letters and digits, starting with a letter.";
  if (USERS && USERS.some(u => u.key === key)) return `There's already a user with key "${key}".`;
  return null;
}

function update() {
  const label = $("label").value.trim();
  if (label) forUser = null;                       // typing a new person replaces "Add keys" for someone
  if (!keyEdited) $("key").value = suggestKey(label);
  const key = $("key").value.trim();
  const problem = forUser ? null : validate(label, key);
  $("err").textContent = forUser ? "" : problem || "";
  const ok = problem === null && USERS;
  $("steps").classList.toggle("show", !!ok);
  if (!ok) return;
  render(forUser ?? { key, label, isNew: true });
}

/** The steps for one person: a new one (MINTY_USERS, keys, Access) or an existing one without keys.
 * Each secret's name has its own Copy button; the values come from the Plaid dashboard. */
function render(p) {
  const K = p.key.toUpperCase();
  const users = [...USERS.filter(u => u.key !== p.key).map(u => `${u.key}:${u.label}`), `${p.key}:${p.label}`].join(",");
  // Every person gets the same slots (PLAID_SLOTS), so take the names from any existing user.
  const slots = (USERS[0]?.slots ?? [{ slot: "primary" }, { slot: "backup" }]).map(s => s.slot);
  const copyBtn = text => `<button type="button" class="mini" data-copy="${esc(text)}">Copy</button>`;
  const rows = slots.flatMap((slot, i) => {
    const S = slot.toUpperCase(), opt = i > 0 ? ` <span class="opt">(optional: a second Plaid account, for more than 10 banks)</span>` : "";
    return [`<li><code>PLAID_CLIENT_ID_${K}_${S}</code>${copyBtn(`PLAID_CLIENT_ID_${K}_${S}`)}<small>Value: the <b>client_id</b>${opt}</small></li>`,
            `<li><code>PLAID_SECRET_${K}_${S}</code>${copyBtn(`PLAID_SECRET_${K}_${S}`)}<small>Value: the <b>Production secret</b> (or Sandbox, for test banks)${opt}</small></li>`];
  });
  const whose = p.isNew ? "their" : p.key === USERS[0]?.key ? "your" : `${esc(p.label)}'s`;
  const steps = [];
  if (p.isNew) {
    steps.push(`<b>Add the person.</b> In Cloudflare, open <b>Workers &amp; Pages → minty → Settings → Variables and secrets</b>.
      Edit the <b>Text</b> variable <code>MINTY_USERS</code> (or <b>+ Add</b> it, type Text) and paste this as its value:
      <ul class="paste"><li><code>${esc(users)}</code>${copyBtn(users)}<small>Every person, in display order</small></li></ul>`);
  }
  steps.push(`<b>Copy ${whose} Plaid keys.</b> Signed in to ${whose} Plaid account, open
    <a href="https://dashboard.plaid.com/developers/keys" target="_blank" rel="noopener noreferrer">Plaid → Developers → Keys</a>.
    It shows the <b>client_id</b> and the <b>secrets</b>: use the <b>Production</b> secret for real banks (Sandbox works for Plaid's test banks).`);
  steps.push(`<b>Paste each one into Cloudflare as a secret.</b> In <b>Variables and secrets</b>, click <b>+ Add</b>, choose type
    <b>Secret</b>, paste the name below as the <b>Variable name</b> (Copy), and paste the key from Plaid as the <b>Value</b>.
    Do it for each row, then click <b>Deploy</b>. Only the first two rows are needed.
    <ul class="paste">${rows.join("")}</ul>`);
  if (p.isNew) {
    steps.push(`<b>Let them sign in.</b> Add their email to the Access policy (<b>Zero Trust → Access → Applications → minty</b>),
      and to <code>ALLOWED_LOGINS</code> if you set one.`);
  }
  steps.push(`<b>That's it.</b> Saving deploys a new version of the Worker right away, no restart. Reload this page:
    the Setup checks above turn ✓ once the keys are in.`);
  $("stepList").innerHTML = steps.map(x => `<li>${x}</li>`).join("");
  $("forWho").textContent = p.isNew ? "" : `These are the steps for ${p.label}'s keys.`;
  $("out").textContent = [
    ...(p.isNew ? [`# in the dashboard: MINTY_USERS = ${users}`, ``] : []),
    ...slots.flatMap((slot, i) => {
      const S = slot.toUpperCase(), note = i === 0 ? "" : "  # optional";
      return [`npx wrangler secret put PLAID_CLIENT_ID_${K}_${S}${note}`, `npx wrangler secret put PLAID_SECRET_${K}_${S}${note}`];
    }),
  ].join("\n");
  $("newname").innerHTML = `<span class="dot" style="background:${color(USERS.some(u => u.key === p.key) ? USERS.findIndex(u => u.key === p.key) : USERS.length)}"></span> ${esc(p.label)}`;
}

$("label").addEventListener("input", update);
$("key").addEventListener("input", () => { keyEdited = $("key").value.trim() !== ""; update(); });
$("form").addEventListener("submit", e => e.preventDefault());
$("users").addEventListener("click", e => {
  const b = e.target.closest("[data-addkeys]");
  if (!b) return;
  const u = USERS.find(x => x.key === b.dataset.addkeys);
  forUser = { key: u.key, label: u.label, isNew: false };
  $("label").value = ""; $("key").value = ""; keyEdited = false;
  $("err").textContent = "";
  $("steps").classList.add("show");
  render(forUser);
  $("steps").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("steps").addEventListener("click", async e => {
  const b = e.target.closest("button[data-copy]");
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; }
  catch { b.textContent = "Select and copy"; }
  setTimeout(() => { b.textContent = "Copy"; }, 1500);
});
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("out").textContent); $("copy").textContent = "Copied"; }
  catch { getSelection().selectAllChildren($("out")); $("copy").textContent = "Press Ctrl+C to copy"; }
  setTimeout(() => { $("copy").textContent = "Copy"; }, 2000);
});

// Light/dark toggle (shares the "minty-theme" preference with the dashboard).
(function themeToggle() {
  const root = document.documentElement, btn = $("themeToggle");
  const apply = t => {
    root.dataset.theme = t;
    const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label); btn.title = label;
  };
  apply(root.dataset.theme);
  btn.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("minty-theme", t); apply(t);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
    if (!localStorage.getItem("minty-theme")) apply(e.matches ? "dark" : "light");
  });
})();

loadStatus();
loadUsers();
loadLock();
