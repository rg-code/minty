let USERS = null;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const color = i => `var(--u${i % 6})`;
let keyEdited = false;

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
  if (!keyEdited) $("key").value = suggestKey(label);
  const key = $("key").value.trim();
  const problem = validate(label, key);
  $("err").textContent = problem || "";
  const ok = problem === null && USERS;
  $("steps").classList.toggle("show", !!ok);
  if (!ok) return;
  const K = key.toUpperCase();
  const users = [...USERS.map(u => `${u.key}:${u.label}`), `${key}:${label}`].join(",");
  // Every person gets the same slots (PLAID_SLOTS), so take the names from any existing user.
  const slots = (USERS[0]?.slots ?? [{ slot: "primary" }, { slot: "backup" }]).map(s => s.slot);
  $("out").textContent = [
    `MINTY_USERS = ${users}`,
    ``,
    ...slots.flatMap((slot, i) => {
      const S = slot.toUpperCase(), note = i === 0 ? "" : "  # optional";
      return [`npx wrangler secret put PLAID_CLIENT_ID_${K}_${S}${note}`, `npx wrangler secret put PLAID_SECRET_${K}_${S}${note}`];
    }),
  ].join("\n");
  $("newname").innerHTML = `<span class="dot" style="background:${color(USERS.length)}"></span> ${esc(label)}`;
}

$("label").addEventListener("input", update);
$("key").addEventListener("input", () => { keyEdited = $("key").value.trim() !== ""; update(); });
$("form").addEventListener("submit", e => e.preventDefault());
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
