/** A small MIME reader for forwarded booking and bill emails (Kos, docs/trips.md §3). It reads what
 * Kos needs from a raw message: the headers, the text and HTML parts (decoded from base64 or
 * quoted-printable, in their charset), and the attachments' names, types and bytes. It doesn't
 * follow links, load anything, or run anything in the message. Pure, with no imports, so the T0
 * scripts (scripts/kos-t0/) run it in Node too. */

export interface Part { headers: Record<string, string>; contentType: string; params: Record<string, string>; body: Uint8Array }
export interface Attachment { filename: string | null; contentType: string; size: number; content: Uint8Array }
export interface Message {
  headers: Record<string, string>;          // lower-cased names; a repeated header keeps every value, joined by "\n"
  subject: string | null;
  from: string | null;
  to: string[];                              // To, Delivered-To and X-Original-To addresses, lower-cased
  date: string | null;
  text: string | null;                       // the first text/plain part
  html: string | null;                       // the first text/html part
  attachments: Attachment[];
}

const enc = new TextEncoder();
const latin1 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };

/** Bytes in a charset; anything a runtime doesn't know is read as UTF-8, then Latin-1. */
export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  const cs = charset.toLowerCase().replace(/^"|"$/g, "");
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "us-ascii" || cs === "ascii") return latin1(bytes);
  try { return new TextDecoder(cs).decode(bytes); }
  catch { try { return new TextDecoder("utf-8").decode(bytes); } catch { return latin1(bytes); } }
}

export function base64(s: string): Uint8Array {
  let clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);                           // a stray character: not a whole byte
  const bin = atob(clean + "==".slice(0, (4 - (clean.length % 4)) % 4));            // padding, which senders often leave off
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function quotedPrintable(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, "");                         // soft line breaks
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else if (c < 128) out.push(c);
    else out.push(...enc.encode(t[i]));
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words in a header: =?utf-8?B?...?= and =?utf-8?Q?...?=. */
export function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs: string, e: string, data: string) =>
    decodeCharset(e.toUpperCase() === "B" ? base64(data) : quotedPrintable(data.replace(/_/g, " ")), cs));
}

/** Headers and the body of a part, from its raw text (headers end at the first blank line). */
function split(raw: string): { headers: Record<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {        // unfold, then one header a line
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}\n${v}` : v;
  }
  return { headers, body };
}

/** "text/html; charset=utf-8; name=x" → its type and parameters. */
export function contentType(v: string | undefined): { type: string; params: Record<string, string> } {
  const [type, ...rest] = (v ?? "text/plain").split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body: string, cte: string | undefined): Uint8Array {
  const e = (cte ?? "7bit").toLowerCase().trim();
  if (e === "base64") return base64(body);
  if (e === "quoted-printable") return quotedPrintable(body);
  const out = new Uint8Array(body.length);                    // 7bit / 8bit / binary: the raw bytes, as read
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

/** Every leaf part, depth first, multiparts opened (up to 8 levels: a forward of a forward). */
export function parts(raw: string, depth = 0): Part[] {
  const { headers, body } = split(raw);
  const { type, params } = contentType(headers["content-type"]);
  if (type.startsWith("multipart/") && params.boundary && depth < 8) {
    const b = `--${params.boundary}`;
    // the line break before a boundary belongs to the boundary, not to the part above it
    return body.split(b).slice(1).filter((s) => !s.startsWith("--")).flatMap((s) => parts(s.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), depth + 1));
  }
  if (type === "message/rfc822" && depth < 8) return parts(body, depth + 1);           // a forwarded message, attached whole
  return [{ headers, contentType: type, params, body: decodeBody(body, headers["content-transfer-encoding"]) }];
}

const addresses = (v: string | undefined) => (v ?? "").split(/[,\n]/).map((a) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase()).filter((a) => a.includes("@"));

/** An HTML part as plain text, for reading a booking from it when the email has no text part (a
 * forwarded email loses its schema.org markup, so its text is all Kos has): blocks and line breaks
 * become new lines, tags go, and the common entities are decoded. Never rendered. */
export function htmlText(html: string | null): string | null {
  if (!html) return null;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rarr: "→", hellip: "…" };
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|section|td)\s*>/gi, (m) => (/td/i.test(m) ? "  " : "\n"))
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : named[e.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
}

/** The text to read an email by: its plain-text part, unless that's a stub ("View this email in your
 * browser") and the HTML says far more, as marketing platforms send; then the HTML as text. */
export function emailText(m: { text: string | null; html: string | null }): string | null {
  const fromHtml = htmlText(m.html);
  if (!m.text) return fromHtml;
  return fromHtml && m.text.trim().length < 400 && fromHtml.length > 1.5 * m.text.trim().length ? fromHtml : m.text;
}

/** The email attached to a forwarded one ("Forward as attachment", or a filter's forward): Gmail keeps
 * its schema.org markup that way, where a typed forward drops it (docs/trips.md §27). Read like any; null
 * when there's none. */
export function attachedMessage(raw: string, depth = 0): Message | null {
  const { headers, body } = split(raw);
  const { type, params } = contentType(headers["content-type"]);
  if (type === "message/rfc822" && depth > 0) {
    const bytes = decodeBody(body, headers["content-transfer-encoding"]);
    let inner = "";
    for (let i = 0; i < bytes.length; i += 0x8000) inner += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return readMessage(inner);
  }
  if (type.startsWith("multipart/") && params.boundary && depth < 8) {
    for (const s of body.split(`--${params.boundary}`).slice(1).filter((x) => !x.startsWith("--"))) {
      const found = attachedMessage(s.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** A raw message (as Gmail's "Show original" or an Email Worker gives it) read for Kos. `raw` is the
 * message as a "binary string" (one char per byte), which is what both deliver. */
export function readMessage(raw: string): Message {
  const { headers } = split(raw);
  const leaves = parts(raw);
  const textOf = (type: string) => {
    const p = leaves.find((x) => x.contentType === type && !/attachment/i.test(x.headers["content-disposition"] ?? ""));
    return p ? decodeCharset(p.body, p.params.charset) : null;
  };
  const attachments = leaves.filter((p) => /attachment/i.test(p.headers["content-disposition"] ?? "") || (!p.contentType.startsWith("text/") && !p.contentType.startsWith("multipart/")))
    .map((p) => ({ filename: decodeWords(contentType(p.headers["content-disposition"]).params.filename ?? p.params.name ?? "") || null,
                   contentType: p.contentType, size: p.body.length, content: p.body }));
  return {
    headers,
    subject: headers.subject ? decodeWords(headers.subject) : null,
    from: addresses(headers.from)[0] ?? null,
    to: [...new Set([...addresses(headers.to), ...addresses(headers["delivered-to"]), ...addresses(headers["x-original-to"])])],
    date: headers.date ?? null,
    text: textOf("text/plain"),
    html: textOf("text/html"),
    attachments,
  };
}

/** The Minty view a message was sent to, from its +address (docs/trips.md §2.1): "trips", "bills", or null. */
export function viewOf(m: Message): "trips" | "bills" | null {
  for (const a of m.to) {
    const tag = /^[^@+]+\+([^@]+)@/.exec(a)?.[1];
    if (tag === "mintytrips") return "trips";
    if (tag === "mintybills") return "bills";
    if (/^trips@/.test(a)) return "trips";
    if (/^bills@/.test(a)) return "bills";
  }
  return null;
}

/** The PDFs attached to an email (an itinerary "see attached"), base64, for the page to read with pdf.js
 * (docs/trips.md §34): the original's first, then a forward's own; at most 3, each at most 1.5 MB. */
export function emailPdfs(...messages: (Message | null | undefined)[]): { filename: string; data: string }[] {
  const out: { filename: string; data: string }[] = [];
  const seen = new Set<string>();
  for (const m of messages) for (const a of m?.attachments ?? []) {
    if (out.length >= 3 || a.content.length > 1_500_000 || a.content.length < 64) continue;
    // a PDF by its first bytes ("%PDF"), whatever its type or name says (some send "application/octet-stream")
    if (String.fromCharCode(...a.content.subarray(0, 4)) !== "%PDF") continue;
    let bin = "";
    for (let i = 0; i < a.content.length; i += 0x8000) bin += String.fromCharCode(...a.content.subarray(i, i + 0x8000));
    const key = `${a.content.length}:${bin.slice(0, 64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filename: (a.filename ?? "attachment.pdf").slice(0, 120), data: btoa(bin) });
  }
  return out;
}
