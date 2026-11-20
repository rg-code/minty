// Reads a sign-up bonus offer's fields from its terms (SUB, docs/sub.md §2a): the reward, a spend
// or deposit requirement and its window, how long the account must stay open, and the annual fee.
// Runs in the browser on pasted text, a PDF's text (pdf.js) or a screenshot's (Tesseract, on
// /sub-scan); nothing leaves the device. Pure, so it's tested in vitest (test/sub-parse.test.ts).
// Every suggestion carries the sentence it came from; whatever it can't find stays empty, never
// guessed. The person checks it all before anything is saved.

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
                fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
const num = (s) => {
  if (s == null) return null;
  const w = WORDS[String(s).toLowerCase()];
  if (w) return w;
  const t = String(s).replace(/[,\s]/g, "");
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(t);
  const n = k ? Number(k[1]) * 1000 : Number(t);
  return Number.isFinite(n) ? n : null;
};
const N = "(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?\\s?[kK]|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|thirty|sixty|ninety)";
const MONEY = "\\$\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{2}))?";
const cents = (whole, frac) => Math.round((num(whole) ?? 0) * 100) + (frac ? Number(frac) : 0);
const unit = (u) => (/^month/i.test(u) ? "months" : "days");

// Issuers, and the program a card's points belong to (BAM's ids, src/points/programs.ts).
const ISSUERS = [
  [/\bAmerican Express\b|\bAmex\b/i, "American Express"], [/\bChase\b/i, "Chase"], [/\bCiti(?:bank)?\b/i, "Citi"],
  [/\bCapital One\b/i, "Capital One"], [/\bBank of America\b/i, "Bank of America"], [/\bWells Fargo\b/i, "Wells Fargo"],
  [/\bDiscover\b/i, "Discover"], [/\bU\.?S\.? Bank\b/i, "U.S. Bank"], [/\bBarclays\b/i, "Barclays"], [/\bSoFi\b/i, "SoFi"],
  [/\bAlly\b/i, "Ally"], [/\bPNC\b/i, "PNC"], [/\bHuntington\b/i, "Huntington"], [/\bTD Bank\b/i, "TD Bank"], [/\bBilt\b/i, "Bilt"],
];
const PROGRAMS = [
  [/Membership Rewards/i, "amex_mr"], [/Ultimate Rewards/i, "chase_ur"], [/ThankYou/i, "citi_typ"], [/Capital One (?:Miles|Venture)|Venture (?:X )?Rewards/i, "capital_one"],
  [/Bilt (?:Rewards|Points)/i, "bilt"], [/MileagePlus|United\b/i, "united"], [/SkyMiles|Delta\b/i, "delta"], [/AAdvantage/i, "american"],
  [/Rapid Rewards|Southwest/i, "southwest"], [/TrueBlue|JetBlue/i, "jetblue"], [/Aeroplan/i, "aeroplan"], [/Avios/i, "ba_avios"],
  [/Bonvoy|Marriott/i, "marriott"], [/Hilton Honors|Hilton\b/i, "hilton"], [/World of Hyatt|Hyatt\b/i, "hyatt"], [/IHG/i, "ihg"],
];

/** Text as PDFs and OCR give it, tidied: ligatures as letters (pdf.js often gives "ﬁ", or "fi rst"
 * with the ligature split from its word), runs of spaces as one. */
export function tidy(text) {
  return String(text ?? "").normalize("NFKC").replace(/\b(f[fil]{1,2}) (?=[a-z]{2})/g, "$1").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/** The text in sentences (terms are often one long paragraph, or OCR's broken lines). */
export function sentences(text) {
  return tidy(text).replace(/\r/g, "").replace(/-\n(?=\w)/g, "").replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9$•*])/).map((s) => s.trim()).filter(Boolean);
}

/** The offer's fields from its terms. Returns { fields, requirements, quotes, used } where quotes
 * maps each field found to the sentence it came from, and used lists those sentences. */
export function parseOffer(text) {
  const all = sentences(text);
  const fields = {}, quotes = {}, requirements = [], used = new Set();
  const find = (re, key, take) => {
    for (const s of all) {
      const m = re.exec(s);
      if (m) { const v = take(m, s); if (v !== undefined) { quotes[key] = s; used.add(s); return v; } }
    }
    return undefined;
  };

  // The reward: points or miles first (a card), else a cash bonus.
  const pts = find(new RegExp(`(?:earn|get|receive)?\\s*${N}\\s+(?:bonus\\s+|extra\\s+)?(points|miles|membership rewards|ultimate rewards|thankyou points)`, "i"), "reward",
    (m) => { const n = num(m[1]); return n && n >= 1000 ? n : undefined; });
  if (pts !== undefined) fields.reward_points = pts;
  else {
    const cash = find(new RegExp(`(?:earn|get|receive|enjoy)\\s+(?:a\\s+|an\\s+)?(?:one-time\\s+)?${MONEY}\\s*(?:cash\\s+)?(?:bonus|reward|statement credit)|${MONEY}\\s+(?:cash\\s+)?bonus`, "i"), "reward",
      (m) => (m[1] ? cents(m[1], m[2]) : cents(m[3], m[4])));
    if (cash !== undefined) fields.reward_cents = cash;
  }
  const program = PROGRAMS.find(([re]) => re.test(text))?.[1];
  if (program && fields.reward_points !== undefined) fields.reward_program = program;
  const issuer = ISSUERS.find(([re]) => re.test(text))?.[1];
  if (issuer) fields.institution = issuer;

  // Spend on a card: "spend $4,000 on purchases in the first 3 months".
  const spend = find(new RegExp(`spend(?:ing)?\\s+(?:at least\\s+)?${MONEY}[^.]*?(?:within|in)\\s+(?:the\\s+)?(?:first\\s+)?${N}\\s+(months?|days?)`, "i"), "spend",
    (m) => ({ kind: "spend", target_cents: cents(m[1], m[2]), length: num(m[3]), unit: unit(m[4]) }));
  if (spend) { requirements.push(spend); fields.kind = "card"; }

  // Deposits for a bank bonus: "direct deposits totaling $500 within 90 days", "two direct deposits of $1,000".
  const dd = find(new RegExp(`(?:${N}\\s+)?(?:or more\\s+)?(?:qualifying\\s+)?(?:electronic\\s+)?direct deposits?[^.]*?(?:totaling|totalling|of at least|of|adding up to)\\s+${MONEY}(?:[^.]*?within\\s+${N}\\s+(months?|days?))?`, "i"), "deposits",
    (m) => ({ kind: "direct_deposits", target_count: num(m[1]) || null, target_cents: cents(m[2], m[3]), length: m[4] ? num(m[4]) : null, unit: m[5] ? unit(m[5]) : null }));
  if (dd) { requirements.push(dd); fields.kind ??= "bank"; }
  else {
    const dep = find(new RegExp(`deposit\\s+(?:at least\\s+)?${MONEY}\\s+(?:or more\\s+)?(?:in\\s+)?(?:new money|new funds)?[^.]*?within\\s+${N}\\s+(months?|days?)`, "i"), "deposits",
      (m) => ({ kind: "deposits", target_cents: cents(m[1], m[2]), length: num(m[3]), unit: unit(m[4]) }));
    if (dep) { requirements.push(dep); fields.kind ??= "bank"; }
  }

  // How long it must stay open: "must remain open for 6 months", "if you close it within 180 days, … forfeit".
  const keep = find(new RegExp(`(?:remain|stay|be kept|keep (?:the|your) account)\\s+open[^.]*?(?:for\\s+)?(?:at least\\s+)?${N}\\s+(months?|days?)|clos(?:e|ed|es|ing)[^.]*?within\\s+${N}\\s+(months?|days?)[^.]*?(?:forfeit|reclaim|deduct|deducted|remove|reverse|charge back)`, "i"), "rule",
    (m, s) => {
      const length = num(m[1] ?? m[3]), u = unit(m[2] ?? m[4]);
      const paid = /after (?:the |your )?(?:bonus|reward|offer)(?: is)? (?:paid|posted|credited|deposited)|after (?:receiving|we pay)/i.test(s);
      return length ? { rule_trigger: paid ? "first_payout" : "opened", rule_length: length, rule_unit: u, rule_text: s } : undefined;
    });
  if (keep) Object.assign(fields, keep);

  // The annual fee, and a first year waived.
  const fee = find(new RegExp(`${MONEY}\\s+annual fee|annual fee(?: of| is)?\\s+${MONEY}`, "i"), "fee", (m) => (m[1] ? cents(m[1], m[2]) : cents(m[3], m[4])));
  if (fee !== undefined) fields.annual_fee_cents = fee;
  if (/\$0 (?:intro(?:ductory)? )?annual fee (?:for )?the first year|annual fee (?:is )?waived (?:for )?the first year|no annual fee the first year/i.test(text)) {
    fields.fee_waived_first_year = true;
  }
  return { fields, requirements, quotes, used: [...used] };
}

/** The terms to keep, up to `max` characters: the sentences the parser used first, then the rest,
 * with a note when some was cut. The link to the full terms stays with the offer. */
export function keepTerms(text, used = [], max = 8000) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const note = "\n\n[Cut to fit: the rest is in the full terms.]";
  const first = used.join("\n");
  const rest = sentences(t).filter((s) => !used.includes(s)).join(" ");
  return (first ? `${first}\n\n${rest}` : rest).slice(0, max - note.length).trimEnd() + note;
}
