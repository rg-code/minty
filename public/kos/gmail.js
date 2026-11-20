// Gmail pull (docs/trips.md §17.1): Kos reads the bookings a person forwards to their own Gmail, with
// no server of anyone's. A short Google Apps Script in their Gmail, deployed as a web app (hosted by
// Google, run as them), returns the emails with one label when asked with their key; Kos reads each
// with the same reader Minty uses (store.readEmail) and offers the bookings to confirm. The script
// asks only to read Gmail; Kos remembers which emails it has read (on this device), so the script
// never changes the mail. The key and the web app's address stay in this browser.

const CONFIG = "kos-gmail", SEEN = "kos-gmail-seen", BILLS_SEEN = "minty-bills-gmail-seen", MAX_SEEN = 1000;
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };

/** The web app's address must be an Apps Script deployment's (…/macros/s/<id>/exec). */
export const isWebApp = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/.test(String(u ?? "").trim());
export const newKey = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function config() { try { const c = JSON.parse(ls.get(CONFIG) ?? "null"); return c && isWebApp(c.url) && /^[0-9a-f]{48}$/.test(c.key) ? c : null; } catch { return null; } }
export function pendingKey() { let k = ls.get(`${CONFIG}-key`); if (!/^[0-9a-f]{48}$/.test(k ?? "")) { k = newKey(); ls.set(`${CONFIG}-key`, k); } return k; }
export function save(url) {
  if (!isWebApp(url)) throw new Error("That isn't a web app address: it should look like https://script.google.com/macros/s/…/exec");
  ls.set(CONFIG, JSON.stringify({ url: url.trim(), key: pendingKey(), label: "Kos" }));
}
/** The link that connects another device (a phone) to the same script: its address and key after a
 * #, so neither is sent to any server; the page saves them and drops them from the address bar. */
export const linkFor = (origin, url, key) =>
  `${origin}/kos/#/gmail?connect=${btoa(JSON.stringify({ u: url, k: key })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
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
  if (!v) throw new Error("That isn't a Kos phone link: copy it again from the set-up page on the device that's connected.");
  ls.set(`${CONFIG}-key`, v.key);
  ls.set(CONFIG, JSON.stringify({ url: v.url, key: v.key, label: "Kos" }));
  return config();
}
/** The person's Gmail address, only to show each trip's address (you+<code>@gmail.com); kept here. */
export const gmailAddress = () => { const a = ls.get(`${CONFIG}-address`) ?? ""; return /^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(a) ? a : ""; };
export function saveAddress(a) {
  const v = String(a ?? "").trim().toLowerCase();
  if (v && !/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error("That doesn't look like an email address (no + in it: Kos adds each trip's code).");
  ls.set(`${CONFIG}-address`, v);
}
export function forget() { ls.set(CONFIG, "null"); ls.set(`${CONFIG}-key`, ""); }

const seenSet = (k = SEEN) => { try { return new Set(JSON.parse(ls.get(k) ?? "[]")); } catch { return new Set(); } };
export function markSeen(ids, k = SEEN) { const s = seenSet(k); for (const id of ids) s.add(id); ls.set(k, JSON.stringify([...s].slice(-MAX_SEEN))); }
/** Bills' own list of emails it has offered (docs/bills.md, by email): separate from Kos's. */
export const markBillsSeen = (ids) => markSeen(ids, BILLS_SEEN);

/** The Apps Script, with the key written in: read-only, the label's emails, newest first, at most 20.
 * `withBills`: on a Minty only, also Bills' view (docs/bills.md, by email); Kos on its own has no Bills,
 * so its script never reads a Bills label. */
export function script(key, label = "Kos", withBills = false) {
  return `// ${withBills ? "Minty's" : "Kos's"} Gmail pull (rg-code/minty docs/trips.md §17.1, §21${withBills ? "; docs/bills.md" : ""}). Runs in YOUR Gmail,
// as you, hosted by Google. It only reads, and only for a request with the key below:
// - the emails labelled "${label}", and those sent to a trip's own address (you+<the trip's code>@gmail.com),
//   from the last 60 days;${withBills ? `
// - for Minty's Bills (view=bills): the emails labelled "Bills" from the last 90 days, each as its
//   plain text and its PDF attachments.` : ""}
// Nothing is changed or sent anywhere else.
const KEY = "${key}";
const LABEL = "${label}";${withBills ? `
const BILLS = "Bills";` : ""}
const CODE = /^[2-9a-hjkmnp-z]{10}$/;

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: "forbidden" });
  const skip = String(e.parameter.seen || "").split(",").filter(Boolean);${withBills ? `
  if (e.parameter.view === "bills") return out({ view: "bills", messages: bills(skip), v: 3 });` : ""}
  const codes = String(e.parameter.codes || "").toLowerCase().split(",").filter(function (c) { return CODE.test(c); }).slice(0, 40);
  const addr = String(e.parameter.address || "").toLowerCase().replace(/[^a-z0-9.@_-]/g, "");
  // the label, or a trip's code anywhere in the message (its address), or the address exactly when Kos knows it
  const terms = ['label:"' + LABEL + '"'].concat(codes, codes.length && addr.indexOf("@") > 0
    ? codes.map(function (c) { const p = addr.split("@"); return "to:" + p[0] + "+" + c + "@" + p[1]; }) : []);
  const threads = GmailApp.search("newer_than:60d {" + terms.join(" ") + "}", 0, 30);
  const messages = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      const id = m.getId();
      if (messages.length >= 20 || skip.indexOf(id) >= 0) return;
      const raw = m.getRawContent();
      if (raw.length > 1500000) return;              // too big to carry (Kos reads up to 2 MB)
      // which trip: a +code in the addresses it was sent to
      const sentTo = [m.getTo(), m.getCc(), m.getHeader("Delivered-To"), m.getHeader("X-Original-To")].join(",").toLowerCase();
      const trip = codes.filter(function (c) { return sentTo.indexOf("+" + c + "@") >= 0; })[0] || null;
      messages.push({ id: id, date: m.getDate().toISOString(), subject: m.getSubject(), raw: raw, trip: trip });
    });
  });
  return out({ label: LABEL, messages: messages, v: 3 });
}
${withBills ? `// Bills: each email's text (for a bill in the email itself) and its PDFs (up to 5, 5 MB each).
function bills(skip) {
  const threads = GmailApp.search('newer_than:90d label:"' + BILLS + '"', 0, 30);
  const messages = [];
  let size = 0;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      const id = m.getId();
      if (messages.length >= 20 || size > 20000000 || skip.indexOf(id) >= 0) return;
      const pdfs = m.getAttachments({ includeInlineImages: false }).filter(function (a) {
        return (/pdf/i.test(a.getContentType()) || /\\.pdf$/i.test(a.getName())) && a.getSize() <= 5000000;
      }).slice(0, 5).map(function (a) { return { name: a.getName(), data: Utilities.base64Encode(a.getBytes()) }; });
      const text = m.getPlainBody().slice(0, 20000);
      pdfs.forEach(function (p) { size += p.data.length; });
      messages.push({ id: id, date: m.getDate().toISOString(), subject: m.getSubject(), text: text, pdfs: pdfs });
    });
  });
  return messages;
}` : ""}
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
/** True when the last check reached a script made before trip addresses (it reads only the label). */
export let oldScript = false;
/** The new emails in the label, or sent to one of `codes`' trip addresses (not read on this device
 * before); each says which trip's code it was sent to (`trip`), when it was. */
export async function pull(codes = []) {
  const c = config();
  if (!c) throw new Error("Gmail pull isn't set up on this device yet.");
  const seen = [...seenSet()].slice(-200);                         // the script skips these
  const u = new URL(c.url);
  u.searchParams.set("key", c.key);
  if (seen.length) u.searchParams.set("seen", seen.join(","));
  const valid = codes.filter((x) => /^[2-9a-hjkmnp-z]{10}$/.test(x)).slice(0, 40);
  if (valid.length) u.searchParams.set("codes", valid.join(","));
  if (valid.length && gmailAddress()) u.searchParams.set("address", gmailAddress());
  let r;
  try { r = await fetch(u, { redirect: "follow", credentials: "omit" }); }
  catch { throw new Error("Couldn't reach your Gmail script. Is this device online, and is the web app deployed for \"Anyone\"?"); }
  const d = await r.json().catch(() => null);
  if (!d) throw new Error("Your Gmail script didn't answer with JSON: check its deployment (Execute as: Me, Who has access: Anyone).");
  if (d.error) throw new Error(d.error === "forbidden" ? "Your Gmail script refused the key: copy the script from this page again, and deploy a new version." : d.error);
  const s = seenSet();
  if (valid.length && !(d.v >= 2)) oldScript = true;             // made before trip addresses: copy it again
  return (d.messages ?? []).filter((m) => !s.has(m.id)).map((m) => ({ ...m, trip: valid.includes(m.trip) ? m.trip : null }));
}

/** Bills by email (docs/bills.md): the new emails in the Bills label (not offered on this device
 * before), each with its text and its PDFs as bytes. The PDFs are read in this browser, like any. */
export async function pullBills() {
  const c = config();
  if (!c) throw new Error("Gmail isn't set up on this device yet.");
  const seen = [...seenSet(BILLS_SEEN)].slice(-200);
  const u = new URL(c.url);
  u.searchParams.set("key", c.key);
  u.searchParams.set("view", "bills");
  if (seen.length) u.searchParams.set("seen", seen.join(","));
  let r;
  try { r = await fetch(u, { redirect: "follow", credentials: "omit" }); }
  catch { throw new Error("Couldn't reach your Gmail script. Is this device online, and is the web app deployed for \"Anyone\"?"); }
  const d = await r.json().catch(() => null);
  if (!d) throw new Error("Your Gmail script didn't answer with JSON: check its deployment (Execute as: Me, Who has access: Anyone).");
  if (d.error) throw new Error(d.error === "forbidden" ? "Your Gmail script refused the key: copy the script from Kos's Gmail set-up page again, and deploy a new version." : d.error);
  if (d.view !== "bills") throw new Error("Your Gmail script is older than Bills by email: copy it again from Kos's Gmail set-up page, and deploy a new version (Deploy → Manage deployments → Edit → New version).");
  const s = seenSet(BILLS_SEEN);
  const bytes = (b64) => { const t = atob(String(b64 ?? "")); const out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };
  return (d.messages ?? []).filter((m) => m && typeof m.id === "string" && !s.has(m.id)).map((m) => ({
    id: m.id, date: String(m.date ?? ""), subject: String(m.subject ?? "").slice(0, 300), text: String(m.text ?? "").slice(0, 20000),
    pdfs: (Array.isArray(m.pdfs) ? m.pdfs : []).slice(0, 5).map((p) => ({ name: String(p?.name ?? "bill.pdf").slice(0, 150), bytes: bytes(p?.data) })),
  }));
}
