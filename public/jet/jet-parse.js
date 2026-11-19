// Reads bookings from pasted text, a PDF's text or a screenshot's (JET, docs/trips.md §3, step 3):
// flights (a flight number and an airport pair, their dates and times) and stays (check-in and
// check-out), with a confirmation code and a total. Pure, so it's tested in vitest
// (test/jet-parse.test.ts). It only suggests: every field it can't find stays empty, and the person
// checks it all before anything is saved. Emails with schema.org markup are read exactly on the
// server instead (src/jet/reservations.ts).

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
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi)) add(m.index, m[3] ? +m[3] : year, MONTHS[m[1].toLowerCase()], +m[2]);
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
const CONF = /\b(?:confirmation|booking|record locator|reservation|pnr)(?:\s+(?:number|code|no\.?|#))?\s*[:#]?\s*([A-Z0-9]{5,10})\b/i;
const TOTAL = /\b(?:total|amount paid|grand total|total price)\b[^$€£¥\d]{0,20}([$€£¥])\s?([\d,]+(?:\.\d{2})?)|\b(?:total|amount paid)\b[^\d]{0,20}([\d,]+(?:\.\d{2})?)\s?(USD|EUR|GBP|JPY|CAD|AUD)\b/i;
const SYMBOL = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/** Bookings found in the text. `isAirport(code)` (optional) keeps airport pairs to real airports.
 * Returns { bookings: [...], quotes: { [i]: sentence } }: each booking with the words it came from. */
/** @param {string} raw @param {{ year?: number, isAirport?: (code: string) => boolean }} [opts] */
export function parseBookings(raw, { year, isAirport = () => true } = {}) {
  const text = tidy(raw);
  const all = { dates: dates(text, year), times: times(text) };
  const bookings = [];
  const conf = CONF.exec(text)?.[1]?.toUpperCase() ?? null;
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
  if (ci && co) {
    const din = after(all.dates, ci.index), dout = after(all.dates, co.index);
    const W = "[A-Z][\\w'&-]*";                                  // a capitalised word (a full stop ends the name)
    const name = new RegExp(`(${W}(?: ${W}){0,5} (?:Hotel|Inn|Resort|Suites|Hostel|Ryokan|Lodge)(?: ${W}){0,3}|(?:Hotel|The) ${W}(?: ${W}){0,4})`).exec(text)?.[1] ?? null;
    if (din && dout && dout.date >= din.date) {
      bookings.push({ kind: "lodging", name, start_at: din.date, end_at: dout.date, confirmation: conf, quote: text.slice(ci.index, Math.min(text.length, co.index + 40)).trim() });
    }
  }
  // the total belongs to the booking when there's just one
  if (bookings.length === 1 && price.price_cents) Object.assign(bookings[0], price);
  return { bookings, price: price.price_cents ? price : null };
}
