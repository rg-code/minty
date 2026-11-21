// Reads bookings from text (Kos, docs/trips.md §3, step 3 and §27): an email without schema.org markup
// (forwarding drops it), pasted text, a PDF's text or a screenshot's. Pure, so it's tested in vitest
// (test/kos-parse.test.ts) and measured against a made-up corpus of six travellers (§27). It only
// suggests: every field it can't find stays empty, and the person checks it all before anything is saved.
//
// General rules only, never one company's layout: a leg is two airports (codes, "(XXX)" or an airport's
// name) with the dates and times nearest them; a train or a bus is a service and its number; a stay is
// its check-in and check-out; a car its pick-up and return; an event, a tour or a restaurant one date and
// time with what's named around it. Shared pieces read dates in their common forms, times, money in its
// currencies and points or miles.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
const WEEKDAY_RE = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?";
const pad = (n) => String(n).padStart(2, "0");

/** Text as emails, PDFs and OCR give it, tidied: ligatures, odd spaces and dashes, and a screenshot's
 * usual misreads next to digits ("16:3O" → "16:30", "l8:16" → "18:16", "2O27" → "2027", "0ct" → "Oct"). */
export function tidy(text) {
  return String(text ?? "").normalize("NFKC")
    .replace(/\b(f[fil]{1,2}) (?=[a-z]{2})/g, "$1").replace(/[‒-―]/g, "-").replace(/[ \t ]+/g, " ")
    // inside number-like tokens only ("16:3O", "2O27", "¥28,34O", "l8:16"), never in a code with letters
    // ("K2OXYZ") or a name ("O2 Arena")
    .replace(/(?<![A-Za-z])[0-9OlI][0-9OlI,.:]*[0-9OlI](?![A-Za-z])/g, (t) => ((t.match(/\d/g) ?? []).length >= 2 && /[OlI]/.test(t) ? t.replace(/O/g, "0").replace(/[lI]/g, "1") : t))
    .replace(/\b0(?=[a-z]{2,})/g, "O")
    .replace(/\r/g, "").replace(/ *\n */g, "\n").trim();
}

// --- dates --------------------------------------------------------------------------------------------
/** The year for a date written without one: the given `year`, else the first year that puts the date on or
 * after `ref` less a week (a booking is for a trip coming up when the email is sent, or a paste is made). */
function yearFor(m, d, { year, ref }) {
  if (year && !ref) return year;
  const r = ref ? new Date(ref) : new Date();
  const y = r.getUTCFullYear(), floor = r.getTime() - 7 * 864e5;
  return Date.UTC(y, m - 1, d) >= floor ? y : y + 1;
}
/** Every date in the text, in order (overlapping forms: the longest wins). "Mar 10, 2027", "Wed, 10 March
 * 2027", "16 Apr 27", "2027-03-10", "16.04.2027", "16/04/2027" (day first when the text is European or the
 * first number can't be a month), "04/16/2027", "26NOV", "26NOV27", "18. 9. 2027". [{ index, end, date }]
 * The second argument is the year for a date without one (or { year, ref, dayFirst }). */
export function dates(text, opt = {}) {
  const o = typeof opt === "number" ? { year: opt } : opt;
  const found = [];
  const add = (m, y, mo, d) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return;
    if (y === null) y = yearFor(mo, d, o);
    else if (y < 100) y += 2000;
    if (y < 2000 || y > 2100) return;
    found.push({ index: m.index, end: m.index + m[0].length, date: `${y}-${pad(mo)}-${pad(d)}` });
  };
  const dayFirst = o.dayFirst ?? /€|\bEUR\b|£|\bGBP\b|\bCHF\b|\bKč\b|\bCZK\b|\d{1,2}\.\d{1,2}\.\d{4}/.test(text);
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m, +m[1], +m[2], +m[3]);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(?:${WEEKDAY_RE}\\s+)?(\\d{4}))?`, "gi"))) add(m, m[3] ? +m[3] : null, MONTHS[m[1].toLowerCase()], +m[2]);
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\.?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}|\\d{2}(?![\\d:])))?`, "gi"))) add(m, m[3] ? +m[3] : null, MONTHS[m[2].toLowerCase()], +m[1]);
  for (const m of text.matchAll(/\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4}|\d{2})?\b/g)) add(m, m[3] ? +m[3] : null, MONTHS[m[2].toLowerCase()], +m[1]);
  for (const m of text.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/g)) add(m, +m[3], +m[2], +m[1]);   // dots: always day first
  for (const m of text.matchAll(/\b(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})\b(?![/-]\d)/g)) {
    const a = +m[1], b = +m[3];
    const df = a > 12 ? true : b > 12 ? false : m[2] === "-" ? true : dayFirst;
    df ? add(m, +m[4], b, a) : add(m, +m[4], a, b);
  }
  found.sort((x, y) => x.index - y.index || (y.end - y.index) - (x.end - x.index));
  const out = [];
  for (const f of found) if (!out.some((g) => f.index < g.end && f.end > g.index)) out.push(f);
  return out.sort((x, y) => x.index - y.index);
}

/** Every time in the text, in order, as 24-hour HH:MM: "11:05 AM", "3:00pm", "23:05", "4 PM", "15h00". */
export function times(text) {
  const out = [];
  const re = /\b(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\.?(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m\.?(?![a-z]))|(?<![\d:.,])\b(\d{1,2})\s?([ap])\.?m\.?(?![a-z])|\b([01]?\d|2[0-3])h([0-5]\d)\b/gi;
  for (const m of text.matchAll(re)) {
    // a duration isn't a time: "Duration 11h30", "Direct · 1h56", "4:35 h", "travel time 2:45"
    if (/(?:duration|durée|dauer|durata|duración|travel time|journey time|flight time|connection|layover|direct\s*·?|total travel)\s*:?\s*$/i.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (/^\s*(?:h|hrs?|hours?|min|mins|minutes)\b/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 8)) && !m[3] && !m[7]) continue;
    if (m[1]) { let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; if (+m[1] <= 12) out.push({ index: m.index, time: `${pad(h)}:${m[2]}` }); }
    else if (m[4]) out.push({ index: m.index, time: `${pad(+m[4])}:${m[5]}` });
    else if (m[6]) { if (+m[6] >= 1 && +m[6] <= 12) { let h = +m[6] % 12; if (/p/i.test(m[7])) h += 12; out.push({ index: m.index, time: `${pad(h)}:00` }); } }
    else out.push({ index: m.index, time: `${pad(+m[8])}:${m[9]}` });
  }
  return out;
}

// --- money and points ---------------------------------------------------------------------------------
const CUR = { "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "円": "JPY", "Kč": "CZK", "MX$": "MXN", "C$": "CAD", "CA$": "CAD", "A$": "AUD" };
const CODES = "USD|EUR|GBP|JPY|CAD|AUD|MXN|CZK|CHF|NZD|SGD|HKD|SEK|NOK|DKK|PLN|HUF|THB|KRW|INR|BRL";
const NUM = "\\d{1,3}(?:[ .,\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const MONEY = new RegExp(`(US\\$|MX\\$|CA\\$|C\\$|A\\$|[$€£¥]|\\b(?:${CODES})\\b)\\s?(${NUM})|(${NUM})\\s?(€|£|¥|円|Kč|yen\\b|\\b(?:${CODES})\\b)`, "gi");
/** "1.234,56" / "1,234.56" / "89,99" / "1 250" / "248,000" → cents (the amount × 100, whatever the currency). */
export function amount(s) {
  let t = String(s).replace(/[\s ]/g, "");
  const lastSep = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (lastSep >= 0 && t.length - lastSep - 1 <= 2) t = t.slice(0, lastSep).replace(/[.,]/g, "") + "." + t.slice(lastSep + 1);
  else t = t.replace(/[.,]/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function moneyAt(line) {
  MONEY.lastIndex = 0;
  const m = MONEY.exec(line);
  if (!m) return null;
  const cur = m[1] ? (CUR[m[1]] ?? m[1].toUpperCase()) : /^yen$/i.test(m[4]) ? "JPY" : (CUR[m[4]] ?? m[4].toUpperCase());
  const cents = amount(m[2] ?? m[3]);
  return cents === null ? null : { price_cents: cents, currency: cur, index: m.index };
}
const TOTAL_LABEL = /\b(grand total|total (?:price|cost|charged|paid|amount|due|for stay|trip cost)|estimated total|amount (?:paid|charged)|you paid|total|totale|gesamt(?:betrag|preis)?|importe total|prix total|preço total|celkem)\b/gi;
/** The booking's total: the money on a total's line (or the next), not a subtotal, a balance or points. */
function totalIn(text) {
  for (const m of text.matchAll(TOTAL_LABEL)) {
    const before = text.slice(Math.max(0, m.index - 4), m.index).toLowerCase();
    if (before.endsWith("sub")) continue;
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
    const line = rest.split("\n").slice(0, 3).join("\n");
    if (/^[^\n\d]*\b(points?|pts|miles|avios)\b/i.test(line.split("\n")[0]) && !/[$€£¥]/.test(line.split("\n")[0])) continue;
    const mo = moneyAt(line);
    if (mo && mo.price_cents > 0) return mo;
  }
  return null;
}
const UNIT = "(?:miles|points|pts|avios|meilen|virgin points|flying blue miles|skymiles|award miles)";
/** Points or miles paid (not earned, not a balance): "70,000 miles + $5.60", "Total: 45,000 Points",
 * "90,000 Points + 1 Free Night", "Paid with 31,412 points". { points, cash } */
export function pointsIn(text) {
  const bad = /\b(earn|earned|you'll earn|balance|available|remaining|status|qualif|bonus|per night|per person|each way)\b/i;
  const lines = text.split("\n");
  const N = "(\\d{1,3}(?:[,.\\s]\\d{3})+|\\d{4,7})";
  // a total of points or miles ("Total points: 66,000", "Total paid: 52,500 Miles + 168,46 €")
  for (const l of lines) {
    if (bad.test(l) || !/\btotal\b/i.test(l)) continue;
    const m = new RegExp(`${N}\\s*${UNIT}`, "i").exec(l) ?? (new RegExp(`\\b(?:points|miles)\\b[^\\d\\n]{0,12}${N}`, "i").test(l) ? new RegExp(`${N}`).exec(l.slice(l.search(/\b(?:points|miles)\b/i))) : null);
    if (m) { const tail = l.slice(m.index + m[0].length); const cash = /^\s*(?:\+|and|plus)/i.test(tail) ? moneyAt(tail) : null; return { points: amount(m[1]) / 100, cash }; }
  }
  // "N unit + money" on one line, not a dated row of a breakdown: the clearest form
  for (const l of lines) {
    if (bad.test(l) || dates(l).length) continue;
    const m = new RegExp(`(\\d{1,3}(?:[,.\\s]\\d{3})+|\\d{4,7})\\s*${UNIT}\\s*(?:\\+|and|plus)\\s*`, "i").exec(l);
    if (m) { const cash = moneyAt(l.slice(m.index + m[0].length)); return { points: amount(m[1]) / 100, cash }; }
  }
  // a total, redeemed or paid-with line naming points
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (bad.test(l) || !/\b(total|redeemed|redemption|used|paid with|award|points? used|miles used|cost|deducted|price)\b/i.test(l)) continue;
    const seg = l + " " + (lines[i + 1] ?? "");
    const m = new RegExp(`(\\d{1,3}(?:[,.\\s]\\d{3})+|\\d{4,7})\\s*${UNIT}`, "i").exec(seg);
    if (m && !bad.test(seg.slice(0, m.index))) return { points: amount(m[1]) / 100, cash: null };
  }
  return null;
}

/** BAM's program named in a text (src/points/programs.ts ids), or null: the program's own name first
 * ("Wyndham Rewards", "MileagePlus"), then the brand alone. */
const PROGRAM_NAMES = [
  [/wyndham rewards/i, "wyndham"], [/marriott bonvoy|\bbonvoy\b/i, "marriott"], [/hilton honors/i, "hilton"], [/world of hyatt/i, "hyatt"],
  [/ihg one rewards|ihg rewards/i, "ihg"], [/mileageplus/i, "united"], [/skymiles/i, "delta"], [/aadvantage/i, "american"],
  [/rapid rewards/i, "southwest"], [/trueblue/i, "jetblue"], [/aeroplan/i, "aeroplan"], [/\bavios\b/i, "ba_avios"],
  [/membership rewards/i, "amex_mr"], [/ultimate rewards|chase travel/i, "chase_ur"], [/thankyou points/i, "citi_typ"], [/bilt rewards/i, "bilt"],
  [/capital one (?:miles|travel)/i, "capital_one"],
  [/\bwyndham\b/i, "wyndham"], [/\bmarriott\b/i, "marriott"], [/\bhilton\b/i, "hilton"], [/\bhyatt\b/i, "hyatt"],
  [/\bunited airlines\b/i, "united"], [/\bdelta air lines\b/i, "delta"], [/\bamerican airlines\b/i, "american"], [/\bsouthwest\b/i, "southwest"], [/\bjetblue\b/i, "jetblue"],
];
export function programIn(text) {
  for (const [re, id] of PROGRAM_NAMES) if (re.test(text)) return id;
  return null;
}
/** Programs BAM doesn't list, named so the person sees whose points they were. */
const OTHER_PROGRAMS = /\b(Mileage Plan|Flying Blue|Flying Club|Virgin Points|Miles & More|Miles&Go|KrisFlyer|Asia Miles|Qantas Points|Executive Club|Avianca LifeMiles|LifeMiles|Turkish Miles&Smiles)\b/i;

// --- confirmation codes -------------------------------------------------------------------------------
const CONF_LABEL = /\b(airline (?:confirmation|booking reference|reference|record locator)|record locator|confirmation(?: number| code| no\.?| #)?|booking (?:number|code|reference|ref\.?|id|no\.?)|reservation (?:number|code|no\.?|id)|reservation|itinerary(?: number| no\.?| #)?|trip (?:number|id)|order (?:number|no\.?|#)|pnr|booking|reference(?: number)?|ticket (?:number|no\.?)|voucher (?:number|code)|pin code)\b\s*(?:is)?\s*[:#]?\s*/gi;
// a code has a digit, or is six capitals (an airline's record locator): "reference" isn't one
const isCode = (c) => (/^(?=.*\d)[A-Z0-9][A-Z0-9/-]{3,22}[A-Z0-9]$/.test(c) && !/^\d{1,4}$/.test(c)) || /^[A-Z]{6}$/.test(c);
/** The booking's confirmation: the airline's own when labelled so, else the first labelled code. Grouped
 * digits ("3057 214 889", "3925.118.442") come back joined. Not a PIN, a loyalty or a ticket number when
 * a confirmation is there. */
function confIn(text) {
  const found = [];
  for (const m of text.matchAll(CONF_LABEL)) {
    const label = m[1].toLowerCase();
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    let g = /^(\d{2,5}(?:[ .]\d{2,5}){1,4})(?![\d])/.exec(rest) ?? /^([A-Za-z0-9][A-Za-z0-9/-]{3,22}[A-Za-z0-9])\b/.exec(rest);
    if ((!g || !isCode(g[1])) && /^\s*\n/.test(text.slice(m.index + m[0].length - 1, m.index + m[0].length + 2)) || (!g && /[:#]\s*$/.test(m[0]))) {
      // the label alone on its line: a code standing alone on one of the next two lines
      const next = text.slice(m.index + m[0].length).split("\n").slice(0, 3).map((x) => x.trim());
      const alone = next.find((x) => /^[A-Z0-9][A-Z0-9-]{4,15}$/.test(x) && isCode(x));
      if (alone) g = [alone, alone];
    }
    if (!g) continue;
    const code = /^\d/.test(g[1]) && /[ .]/.test(g[1]) ? g[1].replace(/[ .]/g, "") : g[1];
    if (!isCode(code) && !(/^\d{4}$/.test(code) && /(?:number|no\.?|code)$/.test(label))) continue;
    const rank = /airline|record locator/.test(label) ? 0 : /pin|ticket/.test(label) ? 3 : /itinerary|order|trip/.test(label) ? 2 : 1;
    found.push({ code, rank, index: m.index });
  }
  found.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return found[0]?.code ?? null;
}

// --- airports ------------------------------------------------------------------------------------------
const COMMON = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "united", "delta", "american", "alaska", "southwest", "national", "express", "boeing", "airlines", "flight", "travel", "receipt", "economy", "business", "first", "premium", "basic", "class", "seats", "total", "taxes", "change", "confirmation", "passenger", "traveler", "summary", "details", "nonstop", "operated", "terminal", "baggage", "check", "points", "miles", "reward", "rewards", "honors", "member", "status", "silver", "golden", "orange", "paradise", "victoria", "william", "james", "george", "henry", "charles", "louis", "marion", "liberty", "eagle", "phoenix", "harbor", "beach", "coast", "springs"]);
const GENERIC = new Set(["international", "airport", "regional", "municipal", "county", "field", "city", "intl", "national", "aerodrome", "airfield", "air", "base", "station", "lake", "port", "saint", "san", "santa", "new", "north", "south", "east", "west", "grand", "bay", "river", "island", "valley", "fort", "mount", "the", "and", "de", "del", "la", "los", "las", "el", "airpark", "heliport", "terminal", "metropolitan", "executive", "memorial", "general", "central", "downtown", "greater", "jetport"]);
const nameIndex = new WeakMap();
/** Distinctive words of airports' names that point at one airport ("heathrow" → LHR, "haneda" → HND). */
function airportWords(airports) {
  if (!airports) return null;
  if (nameIndex.has(airports)) return nameIndex.get(airports);
  const seen = new Map();
  for (const [code, a] of Object.entries(airports)) {
    for (const w of String(a?.[0] ?? "").toLowerCase().replace(/[()]/g, " ").split(/[^a-z'’-]+/)) {
      if (w.length < 5 || GENERIC.has(w) || COMMON.has(w)) continue;
      seen.set(w, seen.has(w) && seen.get(w) !== code ? null : code);
    }
  }
  const idx = new Map([...seen].filter(([, c]) => c));
  nameIndex.set(airports, idx);
  return idx;
}

// airlines by name and by ICAO code, for "Delta 1387", "AEROMEXICO 646", "EZY4873"
const AIRLINES = { united: "UA", delta: "DL", american: "AA", southwest: "WN", alaska: "AS", jetblue: "B6", hawaiian: "HA", frontier: "F9", spirit: "NK",
  "air canada": "AC", westjet: "WS", "british airways": "BA", lufthansa: "LH", "air france": "AF", klm: "KL", aeromexico: "AM", "aeroméxico": "AM",
  "japan airlines": "JL", jal: "JL", ana: "NH", "all nippon": "NH", ryanair: "FR", easyjet: "U2", tap: "TP", "tap air portugal": "TP", iberia: "IB",
  emirates: "EK", qatar: "QR", "singapore airlines": "SQ", cathay: "CX", "virgin atlantic": "VS", eurowings: "EW", swiss: "LX", austrian: "OS",
  "turkish airlines": "TK", vueling: "VY", "norwegian": "DY", qantas: "QF", "air new zealand": "NZ", "korean air": "KE", volaris: "Y4", copa: "CM", avianca: "AV" };
const ICAO = { EZY: "U2", RYR: "FR", BAW: "BA", DLH: "LH", AFR: "AF", KLM: "KL", UAL: "UA", DAL: "DL", AAL: "AA", SWA: "WN", ASA: "AS", JBU: "B6", TAP: "TP", JAL: "JL", ANA: "NH", AMX: "AM", ACA: "AC", VIR: "VS", IBE: "IB" };
const AIRLINE_NAME_RE = new RegExp(`\\b(${Object.keys(AIRLINES).sort((a, b) => b.length - a.length).map((k) => k.replace(/ /g, "\\s+")).join("|")})(?:\\s+(?:airlines?|air\\s+lines|airways))?\\s+(?:flight\\s+)?(?:no\\.?\\s*)?#?(\\d{1,4})\\b(?![:\\d])`, "gi");
const NOT_AIRLINE = new Set(["AM", "PM", "NO", "OF", "TO", "IN", "ON", "AT", "BY", "OR", "ID", "US", "IS", "IT", "AN", "AS", "BE", "DO", "GO", "HE", "IF", "ME", "MY", "SO", "UP", "WE", "OK", "TV", "PO", "PC", "CO", "ST", "RD", "NE", "NW", "SE", "SW", "NY", "CA", "TX", "FL", "HI", "DE", "LA", "VA", "PA", "GA", "AZ", "CT", "MA", "MD", "MI", "MN", "MO", "NC", "NJ", "NV", "OH", "OR", "SC", "TN", "UT", "WA", "WI", "XX"]);
/** Flight numbers in the text: "UA 837", "UA837", "Flight FR 1234", "Delta 1387", "EZY4873". */
function flightNumbers(text) {
  const out = [];
  for (const m of text.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b(?![:\d%])/g)) {
    if (NOT_AIRLINE.has(m[1]) && !/flight|flug|vol|volo|vuelo/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (/\b(airbus|boeing|embraer|bombardier|aircraft|equipment|plane|seat|car|coach|gate|terminal|row)\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index)) || /^A3\d\d$/.test(m[0].replace(/\s/g, ""))) continue;
    if (/^\d/.test(m[1]) && !/[A-Z]/.test(m[1])) continue;
    out.push({ index: m.index, airline: m[1], number: String(+m[2]) });
  }
  for (const m of text.matchAll(/\b(EZY|RYR|BAW|DLH|AFR|KLM|UAL|DAL|AAL|SWA|ASA|JBU|TAP|JAL|ANA|AMX|ACA|VIR|IBE)\s?(\d{1,4})\b(?![:\d])/g)) out.push({ index: m.index, airline: ICAO[m[1]], number: String(+m[2]) });
  for (const m of text.matchAll(AIRLINE_NAME_RE)) out.push({ index: m.index, airline: AIRLINES[m[1].toLowerCase().replace(/\s+/g, " ")], number: String(+m[2]) });
  // "Flight # 2316", "Flight 1544": the airline named in the email, if one is
  const named = new RegExp(`\\b(${Object.keys(AIRLINES).sort((a, b) => b.length - a.length).join("|")})\\b`, "i").exec(text)?.[1];
  for (const m of text.matchAll(/\bflight\s*(?:#|no\.?|number|nr\.?)\s*:?\s*(\d{1,4})\b(?![:\d])/gi)) out.push({ index: m.index, airline: named ? AIRLINES[named.toLowerCase()] : null, number: String(+m[1]) });
  return out.sort((a, b) => a.index - b.index).filter((f, i, a) => !a.some((g, j) => j < i && Math.abs(g.index - f.index) < 4));
}

// --- the reader ----------------------------------------------------------------------------------------
const nearest = (list, i, { max = Infinity, lo = -Infinity, hi = Infinity } = {}) => {
  let best = null;
  for (const x of list) if (x.index >= lo && x.index < hi && Math.abs(x.index - i) <= max && (!best || Math.abs(x.index - i) < Math.abs(best.index - i))) best = x;
  return best;
};
const after = (list, i, hi = Infinity) => list.find((x) => x.index >= i && x.index < hi) ?? null;
const at = (d, t) => (d ? (t ? `${d.date}T${t.time ?? t}` : d.date) : null);
const lineOf = (text, i) => { const a = text.lastIndexOf("\n", i - 1) + 1, b = text.indexOf("\n", i); return text.slice(a, b < 0 ? text.length : b); };
const valueAfter = (text, re) => {
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length).replace(/^[\s:#-]+/, "");
  const v = rest.split("\n")[0].trim();
  return v && v.length <= 140 ? v : null;
};

/** Bookings found in the text. Options: `year` (for dates written without one), or better `ref` (the
 * email's date, or now for a paste: a date without a year is the next one after it); `isAirport(code)`
 * and `airports` (code → [name, city, country, lat, lon]) to keep airport codes real and read airport
 * names; `subject` (an email's, for names). Returns { bookings, price, cancelled, promotional }. */
/** @param {string} raw @param {{ year?: number, ref?: string|number, isAirport?: (code: string) => boolean, airports?: Record<string, any[]>, subject?: string }} [opts] */
export function parseBookings(raw, opts = {}) {
  const airports = opts.airports ?? null;
  const isAirport = opts.isAirport ?? (airports ? (c) => Boolean(airports[c]) : () => true);
  const text = tidy(raw);
  const subject = opts.subject ?? /^\s*subject:\s*(.+)$/im.exec(text)?.[1] ?? "";
  // dates that aren't the trip's: a forwarded email's header line, and when it was booked, issued,
  // purchased or printed, or until when it can be cancelled or paid
  const notTrip = [...text.matchAll(/^[>\s]*(?:date\s*:|sent\s*:|issued?(?: on| date)?\b|date (?:of issue|issued|booked)\b|printed\b|(?:free )?cancell?ation[^\n]{0,40}(?:until|by|before)\b|cancel (?:by|before|until)\b|(?:pay|due|payable)[^\n]{0,20}(?:by|on|before)\b)[^\n]*|^[^\n]{0,32}?\b(?:purchase date|booking date|booked on|date booked|order date|transaction date|payment date|issue date|date of issue|ticket issue date|purchased on|booked:|purchased:)[^\n]*|^\d{1,2}\/\d{1,2}\/\d{2},\s+\d{1,2}:\d{2}\s?[AP]M\b[^\n]*/gim)]
    .map((m) => [m.index, m.index + m[0].length]);
  // a schedule change's old times ("Was 11:25", "Original flight (no longer valid)", struck through):
  // the line, and a block it heads up to the next blank line
  for (const m of text.matchAll(/^[^\n]*(?:\b(?:previous(?:ly)?|original(?:ly)?(?: (?:flight|time|schedule|itinerary|departure|arrival))?|old (?:flight|time|schedule|itinerary)|no longer valid|changed from|formerly|cancell?ed flight)\b|\bwas\s*:|\(was\b|~~)[^\n]*/gim)) {
    const end = text.indexOf("\n\n", m.index);
    const header = !/\d{1,2}[:h]\d{2}/.test(m[0]);
    notTrip.push([m.index, header ? (end < 0 ? text.length : end) : m.index + m[0].length]);
  }
  const inNot = (i) => notTrip.some(([a, b]) => i >= a && i < b);
  const ref = opts.ref ?? null;
  const all = { dates: dates(text, { year: opts.year, ref }).filter((d) => !inNot(d.index)), times: times(text).filter((t) => !inNot(t.index)) };
  const conf = confIn(text);
  const total = totalIn(text);
  const bookings = [];

  // A cancellation or a marketing email isn't a booking (docs/trips.md §27): a cancellation's bookings
  // come back marked, so Kos can offer to delete the one it has.
  const top = `${subject}\n${text.slice(0, 900)}`;
  const cancelled = /\b(?:has been|have been|was|were|is|we've|we have)\s+cancell?ed\b|\bcancell?ation (?:confirmation|confirmed|notice)\b|\byour (?:\w+ ){0,3}(?:is|was|has been) cancell?ed\b|\bcancell?ed:/i.test(top)
    && !/\bfree cancell?ation\b[^\n]{0,30}$/im.test(lineOf(top, top.search(/cancell?ed/i)));
  const promoWords = (text.match(/\b(sale|deals?|offers?|% off|book now|fares? from|from just|limited time|promo code|save up to|starting at|explore|discover)\b/gi) ?? []).length;
  const bookingWords = /\b(confirm(?:ed|ation)|itinerary|reservation|booking|e-?ticket|receipt|ticket number|boarding pass|voucher|your trip|your stay|check-?in)\b/i.test(text);
  // marketing: no confirmation and its own words ("Sale", "fares from"), or a long email with no booking's
  // words and no flight number at all; a short paste is read whatever it says
  const promotional = !conf && (promoWords >= 2 || (!bookingWords && text.length > 1200 && !/\b[A-Z]{2}\s?\d{1,4}\b/.test(text)));

  // --- flights --------------------------------------------------------------------------------------
  const fns = flightNumbers(text);
  const words = airportWords(airports);
  const mentions = [];                                        // { code, index, end, how }
  const pairRe = /\b([A-Z]{3})\s*(?:→|->|–|—|-|>|\bto\b|✈)\s*([A-Z]{3})\b/g;
  const explicit = [];
  for (const m of text.matchAll(pairRe)) if (m[1] !== m[2] && isAirport(m[1]) && isAirport(m[2])) explicit.push({ from: m[1], to: m[2], index: m.index, end: m.index + m[0].length });
  // "(DEN)", "(ORD - O'HARE)", "(Haneda - HND)"
  for (const m of text.matchAll(/\((?:[^()\n]{1,30}?[-–,]\s*)?([A-Z]{3})(?:\s*[-–,][^()\n]{1,30})?\)/g)) {
    if (!isAirport(m[1]) || explicit.some((x) => m.index < x.end && m.index + m[0].length > x.index)) continue;
    if (/\b(connection|connecting|layover|change (?:of )?planes|stopover|customs|recheck|lounge)\b/i.test(lineOf(text, m.index))) continue;
    mentions.push({ code: m[1], index: m.index, end: m.index + m[0].length });
  }
  // a bare code on a line with a time, or after Depart/Arrive/From/To labels ("SFO 06:00", "Depart: JFK")
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (!isAirport(m[1]) || mentions.some((x) => x.index <= m.index && x.end >= m.index + 3) || explicit.some((x) => m.index >= x.index && m.index < x.end)) continue;
    if (/^ [A-Z]{4,}/.test(text.slice(m.index + 3, m.index + 16))) continue;   // "LOS ANGELES", "SAN FRANCISCO", not "OAK 9:15AM"
    const line = lineOf(text, m.index);
    if (/\d{1,2}[:h]\d{2}|\d\s?[ap]\.?m\b/i.test(line) || /\b(depart|arriv|from|to|origin|destination|departure|arrival|dep|arr)\b/i.test(text.slice(Math.max(0, m.index - 25), m.index)))
      if (!/\b(USD|EUR|GBP|JPY|MXN|CAD|AUD|CZK|TAX|FEE)\b/.test(m[1])) mentions.push({ code: m[1], index: m.index, end: m.index + 3 });
  }
  // an airport by its name, near a time or a Depart/Arrive label, where no code is printed ("London Heathrow")
  if (words && (fns.length || /\bflight\b/i.test(text)) && mentions.length + explicit.length * 2 < 2) {
    for (const m of text.matchAll(/\b[A-Z][A-Za-z'’-]{4,}/g)) {
      const code = words.get(m[0].toLowerCase());
      if (!code || mentions.some((x) => Math.abs(x.index - m.index) < 30)) continue;
      const ctx = text.slice(Math.max(0, m.index - 60), m.index + 60);
      if (/\d{1,2}[:h]\d{2}|\d\s?[ap]\.?m\b|\b(depart|arriv|from|to)\b/i.test(ctx)) mentions.push({ code, index: m.index, end: m.index + m[0].length, byName: true });
    }
  }
  mentions.sort((a, b) => a.index - b.index);
  // legs: the explicit pairs, then the mentions two by two (a connection's "FRA … FRA" chains)
  const cands = explicit.map((e) => ({ from: e.from, to: e.to, depAt: e.index, arrAt: e.end - 3, explicit: true }));
  for (let i = 0; i + 1 < mentions.length;) {
    const a = mentions[i], b = mentions[i + 1];
    if (a.code === b.code) { i++; continue; }
    if (b.index - a.index > 420) { i++; continue; }
    if (cands.some((c) => c.explicit && c.depAt <= a.index && c.arrAt + 3 >= b.index)) { i += 2; continue; }
    cands.push({ from: a.code, to: b.code, depAt: a.index, arrAt: b.index });
    i += 2;
  }
  cands.sort((a, b) => a.depAt - b.depAt);
  const legs = [], claimed = new Set(), usedTimes = new Set();
  cands.forEach((c, k) => {
    const lo = k ? cands[k - 1].arrAt + 3 : 0, hi = cands[k + 1]?.depAt ?? text.length;
    // its flight number: the nearest before its departure airport (since the last leg, and not the last
    // leg's), else between its airports or just after them
    const fn = [...fns].reverse().find((f) => !claimed.has(f) && f.index < c.depAt && f.index >= Math.max(lo, c.depAt - 320))
      ?? fns.find((f) => !claimed.has(f) && f.index > c.depAt && f.index < Math.min(hi, c.arrAt + 120));
    if (fn) claimed.add(fn);
    // its dates and times: a block (flight number, then dates and times, then the airports) reads in order;
    // otherwise the date nearest the departure airport and the times nearest each airport
    let d1, d2, t1, t2;
    const blockLo = fn && fn.index < c.depAt ? fn.index : null;
    const bd = blockLo !== null ? all.dates.filter((x) => x.index > blockLo && x.index < c.depAt) : [];
    const bt = blockLo !== null ? all.times.filter((x) => x.index > blockLo && x.index < c.depAt) : [];
    if (bd.length && bt.length >= 1) { [d1, d2] = [bd[0], bd[1] ?? bd[0]]; [t1, t2] = [bt[0], bt[1] ?? null]; }
    else {
      d1 = nearest(all.dates, c.depAt, { lo: Math.max(0, lo - 400), hi }) ?? nearest(all.dates, c.depAt);
      const sameLine = (i) => { const a = text.lastIndexOf("\n", i - 1) + 1, b = text.indexOf("\n", i); return all.times.filter((t) => t.index >= a && t.index < (b < 0 ? text.length : b)); };
      // a pair written inline ("UA 200 ORD → BOS Depart 10:00 AM Arrive 1:15 PM"): the times after it on its line
      const inline = c.explicit ? sameLine(c.arrAt).filter((t) => t.index > c.arrAt) : [];
      t1 = c.explicit ? inline[0] ?? null : sameLine(c.depAt)[0] ?? null;
      const onArr = c.explicit ? inline.slice(1) : sameLine(c.arrAt).filter((t) => t !== t1);
      const free = all.times.filter((t) => !usedTimes.has(t));
      // a table row's times sit on the line below it: after the row first, then just before it
      if (!t1) { const nx = after(free, c.depAt, Math.min(hi, c.arrAt + 200)); t1 = nx && nx.index - c.depAt < 220 ? nx : nearest(free, c.depAt, { max: 90, lo, hi: c.arrAt }); }
      t2 = onArr[0] ?? nearest(free.filter((t) => t !== t1 && (!t1 || t.index > t1.index)), c.arrAt, { max: 160, lo: Math.max(lo, t1?.index ?? lo), hi: Math.min(hi, c.arrAt + 200) });
      // the arrival's date: one on its own line, else the departure's ("+1" moves it below)
      const arrLine = [text.lastIndexOf("\n", c.arrAt - 1) + 1, (text.indexOf("\n", c.arrAt) + 1 || text.length + 1) - 1];
      d2 = all.dates.find((x) => x !== d1 && x.index >= Math.max(arrLine[0], c.depAt) && x.index < arrLine[1]) ?? d1;
    }
    // "+1" (or "next day") after the arrival time moves the arrival a day on
    if (t2 && d1 && d2 === d1 && /^[^\n]{0,14}(?:\+\s?1\b|\(\+1|next day|\+1 day)/i.test(text.slice(t2.index, t2.index + 24))) {
      const n = new Date(`${d1.date}T00:00:00Z`); n.setUTCDate(n.getUTCDate() + 1); d2 = { date: n.toISOString().slice(0, 10) };
    }
    if (t1) usedTimes.add(t1);
    if (t2) usedTimes.add(t2);
    legs.push({ ...c, fn, start_at: at(d1, t1), end_at: t2 ? at(d2, t2) : null, region: [lo, hi] });
  });
  // the same leg twice (a summary, a receipt's fare lines, a seat list): once, keeping the fullest
  const score = (l) => (l.fn ? 4 : 0) + (l.start_at?.length > 10 ? 2 : 0) + (l.end_at ? 1 : 0);
  const kept = [];
  for (const l of legs) {
    const same = kept.find((k) => k.from === l.from && k.to === l.to && (!k.start_at || !l.start_at || k.start_at.slice(0, 10) === l.start_at.slice(0, 10) || !l.fn || !k.fn));
    if (same) {
      // one copy has the flight number, the other the times: keep both
      const [a, b] = score(l) > score(same) ? [l, same] : [same, l];
      const merged = { ...a, fn: a.fn ?? b.fn, start_at: a.start_at?.length > 10 ? a.start_at : b.start_at?.length > 10 ? b.start_at : a.start_at ?? b.start_at, end_at: a.end_at ?? b.end_at };
      kept.splice(kept.indexOf(same), 1, merged);
      continue;
    }
    kept.push(l);
  }
  // a summary leg ("AUS → CUN") that other legs connect (AUS → DFW → CUN), or one with neither a flight
  // number nor a time when others have them, isn't a flight of its own
  const real = kept.filter((l) => {
    const chained = kept.some((a) => a !== l && a.from === l.from && kept.some((b) => b !== l && b !== a && a.to === b.from && b.to === l.to));
    if (chained && !l.fn) return false;
    if (!l.fn && !(l.start_at?.length > 10) && kept.some((k) => k.fn)) return false;
    return true;
  });
  for (const l of real) {
    bookings.push({ kind: "flight", airline: l.fn?.airline ?? null, flight_number: l.fn?.number ?? null, dep_airport: l.from, arr_airport: l.to,
      start_at: l.start_at, end_at: l.end_at, confirmation: conf, quote: text.slice(Math.max(0, l.depAt - 60), l.arrAt + 60).trim() });
  }

  // --- trains and buses -----------------------------------------------------------------------------
  const TRAIN = /\b(Frecciarossa|Frecciargento|Frecciabianca|Italo|TGV(?:\s+INOUI)?|OUIGO|ICE|IC|EC|RJX?|Eurostar|Thalys|Nozomi|Hikari|Kodama|Mizuho|Sakura|Hayabusa|Shinkansen|Alfa Pendular|Intercidades|AVE|Alvia|Acela|Northeast Regional|Texas Eagle|Sunset Limited|Coast Starlight|Cascades|Pacific Surfliner|Empire Builder|Regionale|Railjet|Avanti|Train|Treno|Zug|Comboio)\s*(?:No\.?|Nr\.?|n\.|n°|nº|#|number)?\s*(\d{1,5})\b(?![:\d])/g;
  const BUS = /\b(FlixBus|Flixbus|Greyhound|Megabus|BlaBlaCar Bus|Alsa|RegioJet|National Express|Bus|Coach|Line|Linie)\s*(?:No\.?|#|number)?\s*(\d{1,5})\b(?![:\d])/g;
  const ground = [];
  const isRail = /\b(train|rail|railway|bahn|treno|trenitalia|italo|sncf|renfe|amtrak|eurostar|shinkansen|jr |comboios|station|stazione|gare|bahnhof|platform|coach \d|car \d|carriage|binario)\b/i.test(text);
  const isBus = /\b(bus|flixbus|greyhound|megabus|coach station|bus station|terminal de autobuses)\b/i.test(text);
  if (isRail) for (const m of text.matchAll(TRAIN)) if (!/^(Train|Treno|Zug|Comboio|IC|EC|RJ|RJX|ICE|AVE)$/i.test(m[1]) || /\b(train|treno|zug|comboio)\b/i.test(text.slice(Math.max(0, m.index - 30), m.index + 30)) || /^(ICE|IC|EC|AVE|RJX?)$/.test(m[1])) ground.push({ kind: "train", index: m.index, name: `${m[1].replace(/\s+/g, " ")} ${+m[2]}` });
  if (isBus) for (const m of text.matchAll(BUS)) if (!/^(Bus|Coach|Line|Linie)$/i.test(m[1]) || isBus) ground.push({ kind: "bus", index: m.index, name: `${/^flixbus$/i.test(m[1]) ? "FlixBus" : m[1]} ${m[2]}` });
  ground.sort((a, b) => a.index - b.index);
  const svc = ground.filter((g, i) => !ground.some((h, j) => j < i && h.name === g.name));   // a service named twice: once
  svc.forEach((g, k) => {
    const hi = svc[k + 1]?.index ?? text.length, lo = k ? svc[k - 1].index : 0;
    const region = text.slice(g.index, Math.min(hi, g.index + 700));
    const d = nearest(all.dates, g.index, { lo: Math.max(lo, g.index - 300), hi: Math.min(hi, g.index + 400) }) ?? nearest(all.dates, g.index);
    const ts = all.times.filter((t) => t.index > Math.max(lo, g.index - 200) && t.index < Math.min(hi, g.index + 500) && (!d || t.index > d.index - 120));
    const t1 = ts[0] ?? null, t2 = ts.find((t) => t !== t1 && t.index > (t1?.index ?? 0)) ?? null;
    // where from and to: "A → B" / "A - B" on a line, or From/To labels
    const route = /([A-ZÀ-Ý][\wÀ-ÿ.'’()/ -]{2,45}?)\s*(?:→|->|–|—|\s-\s|\s>\s|\bto\b)\s*([A-ZÀ-Ý][\wÀ-ÿ.'’()/ -]{2,45})/.exec(region)
      ?? /([A-ZÀ-Ý][\wÀ-ÿ.'’()/ -]{2,45}?)\s*(?:→|->|–|—|\s-\s|\s>\s|\bto\b)\s*([A-ZÀ-Ý][\wÀ-ÿ.'’()/ -]{2,45})/.exec(text.slice(Math.max(lo, g.index - 250), g.index));
    const from = valueAfter(region, /\b(?:from|departure station|origin|da|von|de)\s*:/i), to = valueAfter(region, /\b(?:to|arrival station|destination|a|nach|para)\s*:/i);
    const place = route ? `${route[1].trim()} → ${route[2].trim().split(/\s{2,}|\n/)[0]}` : from && to ? `${from} → ${to}` : null;
    bookings.push({ kind: g.kind, name: g.name, start_at: at(d, t1), end_at: t2 && d ? at(d, t2) : null, ...(place ? { place } : {}), confirmation: conf, quote: region.slice(0, 160).trim() });
  });

  // --- a stay -----------------------------------------------------------------------------------------
  const ci = /\bcheck[\s-]?in\b(?! (?:online|opens|closes|desk|counter))[^\n]{0,40}/i.exec(text), co = /\bcheck[\s-]?out\b[^\n]{0,40}/i.exec(text);
  const nights = Number(/\b(\d{1,2})\s*nights?\b|\b(\d{1,2})\s*night\(s\)/i.exec(text)?.slice(1).find(Boolean) ?? 0);
  const stayWords = /\b(hotel|resort|inn|suites|hostel|ostello|apartment|apartamento|airbnb|vrbo|booking\.com|hotels\.com|your stay|room|guest(?:house)?|ryokan|penzion|pension|lodge|villa|condo|listing|property)\b/i.test(text);
  if ((ci && co) || (nights && stayWords)) {
    const coAt = co?.index ?? Infinity;
    let din = ci ? after(all.dates, ci.index, Math.min(text.length, ci.index + 160)) : null, dout = co ? after(all.dates, co.index, co.index + 160) : null;
    if (din && dout && din === dout) dout = null;
    if (!din || !dout || dout.date <= din.date) {
      const gap = (x, y) => Math.round((Date.parse(y.date) - Date.parse(x.date)) / 864e5);
      const pair = all.dates.map((x, i) => [x, all.dates[i + 1]]).find(([x, y]) => y && (nights ? gap(x, y) === nights : gap(x, y) >= 1 && gap(x, y) <= 60));
      if (pair) [din, dout] = pair;
    }
    const tin = ci ? nearest(all.times, ci.index, { max: 80, lo: ci.index, hi: Math.min(coAt, ci.index + 120) }) : null;
    const tout = co ? nearest(all.times, co.index, { max: 80, lo: co.index, hi: co.index + 120 }) : null;
    if (din && dout && dout.date > din.date) {
      bookings.push({ kind: "lodging", name: stayName(text, subject), start_at: at(din, tin), end_at: at(dout, tout), ...(addressIn(text) ? { place: addressIn(text) } : {}),
        confirmation: conf, quote: text.slice(ci?.index ?? din.index, Math.min(text.length, (co?.index ?? dout.index) + 40)).trim() });
    }
  }

  // --- a car ------------------------------------------------------------------------------------------
  const company = /\b(National|Enterprise|Hertz|Avis|Budget|Alamo|Sixt|Thrifty|Dollar|Payless|Fox Rent A Car|Zipcar|Turo|Europcar|Advantage)\b/.exec(text)?.[1] ?? null;
  const pu = /\b(?:pick[\s-]?up|pickup|trip starts|start(?:s)? on|collection)\b/i.exec(text);
  const ret = pu ? /\b(?:return|drop[\s-]?off|trip ends|ends? on)\b/i.exec(text.slice(pu.index + pu[0].length)) : null;
  if (pu && ret && (company || /\b(?:car rental|rental car|rent a car|vehicle|your car|your trip with)\b/i.test(text)) && !bookings.some((b) => b.kind === "flight" && !company)) {
    const retAt = pu.index + pu[0].length + ret.index;
    const din = after(all.dates, pu.index, retAt), dout = after(all.dates, retAt);
    const tAfter = (d, lo) => { const t = d ? after(all.times, Math.min(d.index, lo)) : null; return t && t.index - d.index < 60 && t.index >= Math.min(d.index, lo) - 40 ? t : null; };
    const placeAfter = (i) => {
      const lines = text.slice(i).split("\n").map((x) => x.trim()).filter(Boolean);
      const first = lines[0].replace(/^(?:pick[\s-]?up|pickup|trip starts)\b[^:]*:?\s*/i, "").trim();
      return (first && !/^\W*$/.test(first) && !dates(first).length ? first : lines[1]) ?? null;
    };
    if (din && dout && dout.date >= din.date) {
      const place = placeAfter(pu.index);
      bookings.push({ kind: "car", name: company ?? "Rental car", start_at: at(din, tAfter(din, pu.index)), end_at: at(dout, tAfter(dout, retAt)),
        ...(place && place.length <= 120 && !dates(place).length ? { place } : {}), confirmation: conf, quote: text.slice(pu.index, Math.min(text.length, retAt + 80)).trim() });
    }
  }

  // --- an event, a tour, a restaurant or a transfer: one date and time ------------------------------
  if (!bookings.length) {
    const strongEat = /\b(opentable|resy|table for \d+|party (?:of|0f) \d+|reservation for \d+|\d+ diners|dining room|your table)\b/i.test(text);
    const eventish = /\b(tickets?|admission|concert|show|tour|excursion|experience|luau|voucher|viator|getyourguide|klook|fareharbor|eventbrite|ticketmaster|class|tasting)\b/i.test(subject || text.slice(0, 800));
    const restaurant = strongEat || (!eventish && /\b(restaurant|dinner|lunch|brunch|guests?\s*:?\s*\d|\d+ guests?)\b/i.test(text));
    const transfer = /\b(transfer|shuttle)\b/i.test(subject || text.slice(0, 600));
    const event = /\b(tickets?|admission|show|concert|doors|venue|ticketmaster|eventbrite|viator|getyourguide|klook|fareharbor|tour|excursion|experience|activity|class|tasting|luau|voucher|meeting point|festival|museum|park)\b/i.test(text);
    if (restaurant || event || transfer) {
      const kind = transfer ? "other" : restaurant ? "restaurant" : "event";
      // its time: the show (not the doors), else a labelled date and time, else the first date and its time
      const showAt = /\b(?:show(?:time)?|starts?|start time|begins|event time|tour time|pickup time|meeting time|reservation time|time)\b\s*:?/i.exec(text);
      const inSubject = subject ? dates(subject, { year: opts.year, ref })[0] : null;
      const d = (showAt && nearest(all.dates, showAt.index, { max: 200 })) || (inSubject ? all.dates.find((x) => x.date === inSubject.date) ?? { ...inSubject, index: 0 } : null) || all.dates[0] || null;
      const t = (showAt && nearest(all.times, showAt.index + showAt[0].length, { max: 40, lo: showAt.index })) || (d && after(all.times, d.index, d.index + 120)) || null;
      if (d) {
        const place = valueAfter(text, /\b(?:venue|location|meeting point|address|where|pickup location|pick-up point|restaurant address)\b\s*:?/i);
        bookings.push({ kind, name: eventName(text, subject, kind), start_at: at(d, t), end_at: null, ...(place && !dates(place).length ? { place } : {}), confirmation: conf, quote: text.slice(Math.max(0, d.index - 80), d.index + 80).trim() });
      }
    }
  }

  // --- money and points -------------------------------------------------------------------------------
  const pts = pointsIn(text);
  const first = bookings[0];
  if (first && pts?.points) {
    const target = bookings.find((b) => b.kind === "flight") ?? (bookings.length === 1 ? first : null);
    if (target) {
      target.points = pts.points;
      const near = text;
      target.points_program = programIn(near);
      if (!target.points_program) { const other = OTHER_PROGRAMS.exec(text); if (other) target.points_program_name = other[1]; }
      if (pts.cash) Object.assign(target, { price_cents: pts.cash.price_cents, currency: pts.cash.currency });
    }
  }
  // the total belongs to the booking when there's one (a trip's legs: the first leg carries it)
  const priced = total && !bookings.some((b) => b.price_cents);
  if (priced && bookings.length && (bookings.length === 1 || bookings.every((b) => b.kind === bookings[0].kind))) Object.assign(bookings[0], { price_cents: total.price_cents, currency: total.currency });
  if (cancelled) for (const b of bookings) b.status = "cancelled";
  // a marketing email ("Sale: Berlin → Bergamo from €19.99"): nothing, unless something in it is anchored
  // like a real booking (a flight's number, a train's, a stay's dates)
  if (promotional) {
    const anchored = bookings.filter((b) => (b.kind === "flight" && b.flight_number && b.start_at?.length > 10) || ((b.kind === "train" || b.kind === "bus") && b.start_at?.length > 10)
      || ((b.kind === "lodging" || b.kind === "car") && b.start_at && b.end_at));
    if (!anchored.length) return { bookings: [], price: null, cancelled: false, promotional: true };
    bookings.splice(0, bookings.length, ...anchored);
  }
  return { bookings, price: total ? { price_cents: total.price_cents, currency: total.currency } : null, cancelled, promotional: false };
}

// --- names and places ------------------------------------------------------------------------------------
const W = "['ʻ‘’]?[A-ZÀ-Ý][\\wÀ-ÿ'ʻ’&.-]*";
/** A stay's name: labelled ("Hotel:", "Property:"), or from the subject ("Your booking at X"), or a
 * line naming a hotel, an inn, a resort… */
function stayName(text, subject) {
  const lab = valueAfter(text, /\b(?:hotel|property|accommodation|listing|hotel name|your hotel|place to stay)\b\s*:|\b(?:your stay at|staying at|you're staying at|your reservation at|your booking at)\b\s*:?/i);
  if (lab && lab.length <= 80 && !dates(lab).length) return lab;
  const s = /\b(?:at|for|to|:)\s+([^|·:]{3,80}?)(?:\s+(?:is|has been)\s+confirmed|\s+[-–|·]|\s+on\s|\s+from\s|\s+for\s|\s*\(|$)/i.exec(String(subject).replace(/^(?:fwd?|fw|re):\s*/i, ""));
  if (s && /[A-Z]/.test(s[1]) && !/\b(reservation|booking|trip|confirmation|stay|order)\b/i.test(s[1]) && !dates(s[1]).length && !/\d{4,}/.test(s[1])) return s[1].trim();
  for (const m of text.matchAll(new RegExp(`(${W}(?: ${W}){0,5} (?:Hotel|Inn|Resort|Suites|Hostel|Ostello|Ryokan|Lodge|Villas|Apartments?|Residences?|B&B|Guesthouse|Penzion|Pension)(?: ${W}){0,4}|(?:Hotel|The|Club|Casa|Ostello|Penzion|Hostal|Albergo|Hyatt|Hilton|Marriott|Sheraton|Westin|Andaz|Park Hyatt|Crowne Plaza|Holiday Inn|Hampton Inn|Best Western|Courtyard|Fairfield|Residence Inn|InterContinental|Kimpton) ${W}(?: ${W}){0,5})`, "g"))) {
    const n = m[1].replace(/\s+(?:check|confirmation|reservation|booking)\b.*$/i, "").replace(/[.,;:!]+$/, "").trim();
    if (!/\b(honors|bonvoy|rewards|points|member|elite|club card|vacation resorts|hotels? group|hotels? & resorts)\b/i.test(n)) return n;
  }
  const stay = new RegExp(`(${W}(?: ${W}){0,5} (?:Hotel|Inn|Resort|Suites|Hostel|Ostello|Ryokan|Lodge|Villas|Apartments?|Residences?|B&B|Guesthouse|Penzion|Pension)(?: ${W}){0,4}|(?:Hotel|The|Club|Casa|Ostello|Penzion|Hostal|Albergo|Hyatt|Hilton|Marriott|Sheraton|Westin|Andaz|Park Hyatt|Crowne Plaza|Holiday Inn|Hampton Inn|Best Western|Courtyard|Fairfield|Residence Inn|InterContinental|Kimpton) ${W}(?: ${W}){0,5})`).exec(text)?.[1];
  const name = stay ? stay.replace(/\s+(?:check|confirmation|reservation|booking)\b.*$/i, "").trim() : null;
  return name && !/\b(honors|bonvoy|rewards|points|member|elite|club card)\b/i.test(name) ? name : null;
}
/** An address line: US ("100 Example Road, Town, ST 12345"), or one with a postal code ("Via X 12, 50123
 * Florence, Italy", "1-2-3 Ginza, Chuo-ku, Tokyo 104-0061"), or labelled "Address:". */
function addressIn(text) {
  const lab = valueAfter(text, /\baddress\b\s*:/i);
  if (lab && /\d/.test(lab) && !dates(lab).length && !/@|https?:/.test(lab)) return lab;
  const us = /^(\d{1,6}[A-Za-z]? [^\n]{3,90}?\b[A-Z]{2} \d{5}(?:-\d{4})?)\b/m.exec(text)?.[1];
  if (us) return us;
  for (const m of text.matchAll(/^([^\n]{3,60}?\d[^\n]{0,40}?,\s*(?:[^\n,]{2,40},\s*){0,2}(?:\d{4,5}|\d{3}-\d{4}|[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})[^\n]{0,50})$/gm)) {
    const a = m[1].trim();
    if (!dates(a).length && !times(a).length && !/\b(tel|phone|fax|www\.|http|@|total|price|points?)\b/i.test(a) && a.length <= 140) return a;
  }
  return null;
}
/** An event's, a tour's or a restaurant's name: labelled, else the subject without its wrapping words. */
function eventName(text, subject, kind) {
  const lab = valueAfter(text, kind === "restaurant" ? /\b(?:restaurant|reservation at|your table at)\b\s*:?/i : /\b(?:tour|activity|event|experience|product|show|ticket type|excursion)\b\s*:/i);
  if (lab && lab.length <= 90 && !dates(lab).length) return lab;
  const s = String(subject).replace(/^(?:fwd?|fw|re):\s*/i, "")
    .replace(/^(?:your |booking |order |reservation )?(?:booking |reservation |order )?(?:#?\s?[\w-]*\d[\w-]*\s+)?(?:is |has been )?(?:confirmed|confirmation)[:\s-]*/i, "")
    .replace(/\s*[-–|·]\s*(?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s+\w+\s+\d{1,2},?\s+\d{4}\s*$/i, "")
    .replace(/^(?:your tickets? (?:for|to)|you'?re going to|you'?re all set(?: for)?|tickets? for|your reservation (?:at|for)|reservation (?:at|for)|your booking (?:for|at)|thanks for booking|you'?re booked(?: for| at)?)\s*:?\s*/i, "")
    .replace(/\s*[-–|·]\s*(?:booking|order|confirmation|reservation)\b.*$/i, "").replace(/\s+(?:on|for)\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*.*$/i, "").trim();
  if (s && s.length <= 100) return s;
  // a screenshot or a paste: its first prominent line ("The Harbor Table"), not the app's own words
  for (const l of text.split("\n").slice(0, 8)) {
    const t = l.replace(/[^\wÀ-ÿ'’&.,\- ]/g, "").trim();
    if (t.length >= 4 && t.length <= 60 && /^(?:[A-ZÀ-Ý][\wÀ-ÿ'’&.-]*|the|of|and|at|de|la|&)(?:\s+(?:[A-ZÀ-Ý][\wÀ-ÿ'’&.-]*|the|of|and|at|de|la|&))+$/.test(t) && !dates(t).length && !times(t).length
      && !/\b(reservation|confirmed|details|booking|order|ticket|skip|menu|home|account|trips?|upcoming|share|directions)\b/i.test(t)) return t;
  }
  return null;
}
