// Device lock: before Minty shows anything on this device, ask for its Face ID, fingerprint,
// Windows Hello or screen lock. It's a visibility gate, nothing more: it runs between this page
// and the device (WebAuthn with a passkey kept on the device), never talks to the Worker, and
// stores nothing in Minty's database. The data itself is protected by Cloudflare Access and the
// Worker, as before.
//
// On by default where the device can do it: the first visit offers "Turn on" (one setup prompt)
// or "Not on this device". Devices without a built-in authenticator are never locked, so nobody
// can be locked out. Loaded render-blocking in <head> with lock.css, so nothing shows first.
(function () {
  const KEY = "minty_lock";            // localStorage: {state: "on", cred} | {state: "off"}
  const SEEN = "minty_lock_seen";      // sessionStorage: this tab was last open and unlocked at (ms)
  const RELOCK_MS = 5 * 60 * 1000;     // away longer than this: locked again
  const root = document.documentElement;

  const store = (s, k, v) => { try { if (v === undefined) return s.getItem(k); if (v === null) s.removeItem(k); else s.setItem(k, v); } catch {} return null; };
  const read = () => { try { return JSON.parse(store(localStorage, KEY)) || null; } catch { return null; } };
  const save = (v) => store(localStorage, KEY, v ? JSON.stringify(v) : null);
  const seen = () => store(sessionStorage, SEEN, String(Date.now()));
  const recent = () => Date.now() - Number(store(sessionStorage, SEEN) || 0) < RELOCK_MS;

  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  /** Whether this device has a built-in authenticator that checks who you are. */
  async function available() {
    try {
      return !!(window.isSecureContext && window.PublicKeyCredential &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  }

  /** One setup prompt: a passkey for this device only. */
  async function create() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32),
      rp: { name: "Minty", id: location.hostname },
      user: { id: rand(16), name: "Minty on this device", displayName: "Minty" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      attestation: "none", timeout: 60000,
    } });
    save({ state: "on", cred: b64u(cred.rawId) });
  }

  /** Face ID / fingerprint / screen lock, and the authenticator says it checked (the UV flag). */
  async function verify() {
    const st = read();
    if (!st || st.state !== "on" || !st.cred) throw new Error("not set up");
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
      allowCredentials: [{ type: "public-key", id: unb64u(st.cred) }],
    } });
    const flags = new Uint8Array(a.response.authenticatorData)[32];
    if (!(flags & 0x04)) throw new Error("not verified");
  }

  // ---- the cover ---------------------------------------------------------------------------
  let cover = null, mode = null;
  const TEXT = {
    setup: ["Lock Minty on this device?",
            "Ask for Face ID, your fingerprint or this device's screen lock before Minty shows your money here. Nothing leaves the device.",
            "Turn on", "Not on this device"],
    unlock: ["Minty is locked", "Unlock with Face ID, your fingerprint or this device's screen lock.", "Unlock", null],
  };

  function show(m, error = "") {
    mode = m;
    root.classList.add("minty-locked");
    if (!document.body) { document.addEventListener("DOMContentLoaded", () => mode && show(mode, error), { once: true }); return; }
    if (!cover) {
      cover = document.createElement("div");
      cover.id = "minty-lock";
      cover.setAttribute("role", "dialog");
      cover.setAttribute("aria-modal", "true");
      cover.setAttribute("aria-labelledby", "minty-lock-title");
      cover.innerHTML = `<div class="card"><img src="/favicon.svg" alt="" width="48" height="48" />
        <h1 id="minty-lock-title"></h1><p class="why"></p>
        <button type="button" class="primary"></button><button type="button" class="secondary"></button>
        <button type="button" class="secondary again" hidden>Set up again</button><p class="err" role="alert"></p></div>`;
      cover.querySelector(".primary").addEventListener("click", primary);
      cover.querySelector(".secondary:not(.again)").addEventListener("click", () => { save({ state: "off" }); hide(); });
      cover.querySelector(".again").addEventListener("click", () => run(async () => { await create(); }, "Couldn't set it up. Try again."));
      document.body.appendChild(cover);
    }
    const [title, why, main, alt] = TEXT[m];
    cover.querySelector("h1").textContent = title;
    cover.querySelector(".why").textContent = why;
    cover.querySelector(".primary").textContent = main;
    const altBtn = cover.querySelector(".secondary:not(.again)");
    altBtn.hidden = !alt;
    if (alt) altBtn.textContent = alt;
    cover.querySelector(".err").textContent = error;
    cover.hidden = false;
    cover.querySelector(".primary").focus();
  }

  function hide() {
    mode = null;
    seen();
    root.classList.remove("minty-locked");
    if (cover) cover.hidden = true;
  }

  async function run(step, failure) {
    const btns = cover ? [...cover.querySelectorAll("button")] : [];
    btns.forEach((b) => (b.disabled = true));
    try {
      await step();
      hide();
    } catch {
      show(mode || "unlock", failure);
      if (mode === "unlock") cover.querySelector(".again").hidden = false;   // e.g. the passkey was deleted
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  }

  function primary() {
    if (mode === "setup") run(create, "It wasn't turned on. Try again, or choose “Not on this device”.");
    else run(verify, "Couldn't unlock. Try again.");
  }

  // ---- when to lock ------------------------------------------------------------------------
  function lockIfNeeded() {
    const st = read();
    if (st && st.state === "off") return;
    if (st && st.state === "on" && recent()) { seen(); return; }
    root.classList.add("minty-locked");                       // before first paint
    available().then((ok) => {
      if (!ok) { root.classList.remove("minty-locked"); return; }   // nothing to unlock with: never locked out
      show(st && st.state === "on" ? "unlock" : "setup");
    });
  }

  // Away (another app, tab, or the bank's OAuth page) for longer than RELOCK_MS: locked again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (!mode) seen(); }
    else if (!mode && read()?.state === "on" && !recent()) lockIfNeeded();
  });
  addEventListener("pagehide", () => { if (!mode) seen(); });

  /** For the "This device" line in Setup checks (add-user.html). */
  window.MintyLock = {
    async status() {
      if (!(await available())) return "unavailable";
      const st = read();
      return st ? st.state : "unset";
    },
    async turnOn() { await create(); seen(); },
    async turnOff() { await verify(); save({ state: "off" }); },
  };

  lockIfNeeded();
})();
