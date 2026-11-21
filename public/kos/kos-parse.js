// Reads bookings from pasted text, a PDF's text or a screenshot's (Kos, docs/trips.md §3, step 3):
// flights (a flight number and an airport pair, their dates and times) and stays (check-in and
// check-out), with a confirmation code and a total. Pure, so it's tested in vitest
// (test/kos-parse.test.ts). It only suggests: every field it can't find stays empty, and the person
// checks it all before anything is saved. Emails with schema.org markup are read exactly on the
// server instead (src/kos/reservations.ts).

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** Text as PDFs and OCR give it, tidied: ligatures, odd spaces and dashes. */
export function tidy(text) {
  return String(text ?? "").normalize("NFKC").replace(/\b(f[fil]{1,2}) (?=[a-z]{2})/g, "$1").replace(/[‒-―]/g, "-").replace(/[ \t ]+/g, " ").trim();
}

/** Every date in the text, in order: "Mar 10, 2027", "10 March 2027", "2027-03-10", "Wed, Mar 10"
 * (the year from `year` when it's missing). [{ index, date }] */
export function dates(text, year = new Date().getFullYear()) {
  const out = [];
  const add = (i, y, m, d) => { if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.push({ index: i, date: `${y}-${pad(m)}-${pad(d)}` }); };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index, +m[1], +m[2], +m[3]);
  // a day is one or two digits not followed by another ("March 2027" isn't March 20)
  // the year may follow the weekday, or sit on the next line ("NOV 26  THU\n2026", as some emails lay it out)
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(\d{4}))?/gi)) add(m.index, m[3] ? +m[3] : year, MONTHS[m[1].toLowerCase()], +m[2]);
  for (const m of text.matchAll(/\b(\d{1,2})(?!\d)(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/gi)) add(m.index, m[3] ? +m[3] : year, MONTHS[m[2].toLowerCase()], +m[1]);
  return out.sort((a, b) => a.index - b.index);
}

/** Every time in the text, in order, as 24-hour HH:MM: "11:05 AM", "3:00pm", "23:05". [{ index, time }] */
export function times(text) {
  const out = [];
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\.?\b|\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m)/gi)) {
    if (m[1]) { let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; out.push({ index: m.index, time: `${pad(h)}:${m[2]}` }); }
    else out.push({ index: m.index, time: `${pad(+m[4])}:${m[5]}` });
  }
  return out;
}

const after = (list, i) => list.find((x) => x.index >= i);
const CONF = /\b(?:confirmation|booking|record locator|reservation|pnr)(?:\s+(?:number|code|no\.?|#|reference|ref\.?))?\s*[:#]?\s*([A-Za-z0-9]{5,16})\b/gi;
// a code has a digit, or is six capitals (an airline's record locator), as written: "reference" isn't one
const isCode = (c) => /^(?=.*\d)[A-Z0-9]{5,16}$/.test(c) || /^[A-Z]{6}$/.test(c);
const TOTAL = /\b(?:total|amount paid|grand total|total price)\b[^$€£¥\d]{0,20}([$€£¥])\s?([\d,]+(?:\.\d{2})?)|\b(?:total|amount paid)\b[^\d]{0,20}([\d,]+(?:\.\d{2})?)\s?(USD|EUR|GBP|JPY|CAD|AUD)\b/i;
const SYMBOL = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/** Bookings found in the text. `isAirport(code)` (optional) keeps airport pairs to real airports.
 * Returns { bookings: [...], quotes: { [i]: sentence } }: each booking with the words it came from. */
/** @param {string} raw @param {{ year?: number, isAirport?: (code: string) => boolean }} [opts] */
export function parseBookings(raw, { year, isAirport = () => true } = {}) {
  const text = tidy(raw);
  const all = { dates: dates(text, year), times: times(text) };
  const bookings = [];
  const conf = [...text.matchAll(CONF)].map((m) => m[1]).find(isCode) ?? null;
  const total = TOTAL.exec(text);
  const price = total ? { price_cents: Math.round(Number((total[2] ?? total[3]).replace(/,/g, "")) * 100), currency: total[1] ? SYMBOL[total[1]] : total[4].toUpperCase() } : {};

  // Flights: a flight number near an airport pair: "UA 837 SFO → NRT", "SFO-NRT United 837".
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z]{3})\s*(?:→|->|-|–|to|✈)\s*([A-Z]{3})\b/g)) {
    const [from, to] = [m[1], m[2]];
    if (from === to || !isAirport(from) || !isAirport(to)) continue;
    // the flight number just before the airports (else just after), not another leg's
    const FN = /\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{1,4})\b/g;
    const before = [...text.slice(Math.max(0, m.index - 40), m.index).replace(/\b[A-Z]{3}\b/g, " ").matchAll(FN)].at(-1);
    const fn = before ?? FN.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/\b[A-Z]{3}\b/g, " "));
    const key = `${from}${to}${fn?.[0] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // its date and times: the first ones after the airports (else the last date before)
    const d = after(all.dates, m.index) ?? [...all.dates].reverse().find((x) => x.index < m.index), t1 = after(all.times, m.index), t2 = t1 ? after(all.times, t1.index + 1) : null;
    const sentence = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).trim();
    bookings.push({ kind: "flight", airline: fn?.[1] ?? null, flight_number: fn?.[2] ?? null, dep_airport: from, arr_airport: to,
      start_at: d ? (t1 ? `${d.date}T${t1.time}` : d.date) : null, end_at: d && t2 ? `${d.date}T${t2.time}` : null,
      confirmation: conf, quote: sentence });
  }

  // A stay: check-in and check-out dates, and the hotel's name if a line says Hotel, Inn, Resort...
  const ci = /check[\s-]?in\b[^\n]{0,30}/i.exec(text), co = /check[\s-]?out\b[^\n]{0,30}/i.exec(text);
  const nights = Number(/\b(\d{1,2})\s*nights?\b|\b(\d{1,2})\s*night\(s\)/i.exec(text)?.slice(1).find(Boolean) ?? 0);
  if ((ci && co) || nights) {
    let din = ci ? after(all.dates, ci.index) : null, dout = co ? after(all.dates, co.index) : null;
    // some emails put the dates above the labels ("NOV 26 … NOV 29 … Check-In 4:00 p.m."): then the first
    // two dates that are the stay's nights apart (or, with no count, the first pair 1 to 60 days apart)
    if (!din || !dout || dout.date < din.date) {
      const gap = (x, y) => Math.round((Date.parse(y.date) - Date.parse(x.date)) / 864e5);
      const pair = all.dates.map((x, i) => [x, all.dates[i + 1]]).find(([x, y]) => y && (nights ? gap(x, y) === nights : gap(x, y) >= 1 && gap(x, y) <= 60));
      [din, dout] = pair ?? [null, null];
    }
    const W = "['ʻ‘’]?[A-Z][\\w'ʻ’&-]*";                         // a capitalised word (a full stop ends the name; Hawaiian ʻokina too)
    const name = new RegExp(`(${W}(?: ${W}){0,5} (?:Hotel|Inn|Resort|Suites|Hostel|Ryokan|Lodge|Villas)(?: ${W}){0,3}|(?:Hotel|The|Club) ${W}(?: ${W}){0,4})`).exec(text)?.[1] ?? null;
    // the check-in and check-out times, when they follow their labels ("Check-In 4:00 p.m.")
    const at = (label) => { if (!label) return null; const t = after(all.times, label.index); return t && t.index - label.index < 40 ? t.time : null; };
    // the street address, as a US or similar address line gives it ("100 Example Road, Town, HI 96700")
    const place = /^(\d{1,6} [^\n]{3,80}?\b[A-Z]{2} \d{5}(?:-\d{4})?)\b/m.exec(text)?.[1] ?? null;
    if (din && dout && dout.date >= din.date) {
      const tin = at(ci), tout = at(co);
      bookings.push({ kind: "lodging", name, start_at: tin ? `${din.date}T${tin}` : din.date, end_at: tout ? `${dout.date}T${tout}` : dout.date,
        ...(place ? { place } : {}), confirmation: conf, quote: text.slice(ci?.index ?? din.index, Math.min(text.length, (co?.index ?? dout.index) + 40)).trim() });
    }
  }
  // a stay paid in points ("Total for Stay 90,000 Pts.")
  const pts = /\btotal\b[^\n\d]{0,30}([\d,]{3,})\s*(?:pts|points)\b/i.exec(text);
  if (bookings.length === 1 && pts && !price.price_cents) bookings[0].points = Number(pts[1].replace(/,/g, ""));
  // the total belongs to the booking when there's just one
  if (bookings.length === 1 && price.price_cents) Object.assign(bookings[0], price);
  return { bookings, price: price.price_cents ? price : null };
}
