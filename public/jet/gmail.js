// Gmail pull (docs/trips.md §17.1): JET reads the bookings a person forwards to their own Gmail, with
// no server of anyone's. A short Google Apps Script in their Gmail, deployed as a web app (hosted by
// Google, run as them), returns the emails with one label when asked with their key; JET reads each
// with the same reader Minty uses (store.readEmail) and offers the bookings to confirm. The script
// asks only to read Gmail; JET remembers which emails it has read (on this device), so the script
// never changes the mail. The key and the web app's address stay in this browser.

const CONFIG = "jet-gmail", SEEN = "jet-gmail-seen", MAX_SEEN = 1000;
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };

/** The web app's address must be an Apps Script deployment's (…/macros/s/<id>/exec). */
export const isWebApp = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/.test(String(u ?? "").trim());
export const newKey = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function config() { try { const c = JSON.parse(ls.get(CONFIG) ?? "null"); return c && isWebApp(c.url) && /^[0-9a-f]{48}$/.test(c.key) ? c : null; } catch { return null; } }
export function pendingKey() { let k = ls.get(`${CONFIG}-key`); if (!/^[0-9a-f]{48}$/.test(k ?? "")) { k = newKey(); ls.set(`${CONFIG}-key`, k); } return k; }
export function save(url) {
  if (!isWebApp(url)) throw new Error("That isn't a web app address: it should look like https://script.google.com/macros/s/…/exec");
  ls.set(CONFIG, JSON.stringify({ url: url.trim(), key: pendingKey(), label: "JET" }));
}
/** The link that connects another device (a phone) to the same script: its address and key after a
 * #, so neither is sent to any server; the page saves them and drops them from the address bar. */
export const linkFor = (origin, url, key) =>
  `${origin}/jet/#/gmail?connect=${btoa(JSON.stringify({ u: url, k: key })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
export function phoneLink(origin = location.origin) { const c = config(); return c ? linkFor(origin, c.url, c.key) : null; }
/** A phone link (or just its code) back to { url, key }, or null when it isn't one. */
export function readLink(text) {
  const t = String(text ?? "").trim(), code = /[?&]connect=([\w-]+)/.exec(t)?.[1] ?? (/^[\w-]+$/.test(t) ? t : "");
  try {
    const v = JSON.parse(atob(code.replace(/-/g, "+").replace(/_/g, "/")));
    return isWebApp(v?.u) && /^[0-9a-f]{48}$/.test(v?.k ?? "") ? { url: v.u, key: v.k } : null;
  } catch { return null; }
}
/** Connect this device with a phone link, as made on the device that's set up. */
export function connect(text) {
  const v = readLink(text);
  if (!v) throw new Error("That isn't a JET phone link: copy it again from the set-up page on the device that's connected.");
  ls.set(`${CONFIG}-key`, v.key);
  ls.set(CONFIG, JSON.stringify({ url: v.url, key: v.key, label: "JET" }));
  return config();
}
export function forget() { ls.set(CONFIG, "null"); ls.set(`${CONFIG}-key`, ""); }

const seenSet = () => { try { return new Set(JSON.parse(ls.get(SEEN) ?? "[]")); } catch { return new Set(); } };
export function markSeen(ids) { const s = seenSet(); for (const id of ids) s.add(id); ls.set(SEEN, JSON.stringify([...s].slice(-MAX_SEEN))); }

/** The Apps Script, with the key written in: read-only, the label's emails, newest first, at most 20. */
export function script(key, label = "JET") {
  return `// JET's Gmail pull (rg-code/minty docs/trips.md §17.1). Runs in YOUR Gmail, as you, hosted by
// Google. It only reads: the emails labelled "${label}" from the last 60 days, and only for a
// request with the key below. Nothing is changed or sent anywhere else.
const KEY = "${key}";
const LABEL = "${label}";

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: "forbidden" });
  const skip = String(e.parameter.seen || "").split(",").filter(Boolean);
  const threads = GmailApp.search('label:"' + LABEL + '" newer_than:60d', 0, 30);
  const messages = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      const id = m.getId();
      if (messages.length >= 20 || skip.indexOf(id) >= 0) return;
      const raw = m.getRawContent();
      if (raw.length > 1500000) return;              // too big to carry (JET reads up to 2 MB)
      messages.push({ id: id, date: m.getDate().toISOString(), subject: m.getSubject(), raw: raw });
    });
  });
  return out({ label: LABEL, messages: messages });
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;
}
export const MANIFEST = `{
  "timeZone": "Etc/UTC",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}`;

/** A raw message as Apps Script gives it (a string), as bytes: one per character when it's all
 * 8-bit (the usual case: MIME is 7-bit with base64 or quoted-printable), else UTF-8. */
export function rawBytes(raw) {
  let wide = false;
  for (let i = 0; i < raw.length && !wide; i++) if (raw.charCodeAt(i) > 255) wide = true;
  if (wide) return new TextEncoder().encode(raw);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The new emails in the label (not read on this device before). */
export async function pull() {
  const c = config();
  if (!c) throw new Error("Gmail pull isn't set up on this device yet.");
  const seen = [...seenSet()].slice(-200);                         // the script skips these
  const u = new URL(c.url);
  u.searchParams.set("key", c.key);
  if (seen.length) u.searchParams.set("seen", seen.join(","));
  let r;
  try { r = await fetch(u, { redirect: "follow", credentials: "omit" }); }
  catch { throw new Error("Couldn't reach your Gmail script. Is this device online, and is the web app deployed for \"Anyone\"?"); }
  const d = await r.json().catch(() => null);
  if (!d) throw new Error("Your Gmail script didn't answer with JSON: check its deployment (Execute as: Me, Who has access: Anyone).");
  if (d.error) throw new Error(d.error === "forbidden" ? "Your Gmail script refused the key: copy the script from this page again, and deploy a new version." : d.error);
  const s = seenSet();
  return (d.messages ?? []).filter((m) => !s.has(m.id));
}
