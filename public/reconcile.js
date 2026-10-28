// The Select bar's Summary (app.js): totals, and the selected transactions matched up the way a
// bookkeeper would. A charge and its exact refund, a move between two of the household's own
// accounts, merchants refunded only in part, and what's left unbalanced. Pure: it works on the rows
// the page already has (no request, no storage), and the tests call it directly.
// Amounts are Plaid's: positive is money out.
(function () {
  const DAY = 864e5;
  const STOP = new Set(["the", "sq", "tst", "pos", "www", "paypal", "pp", "dd", "ach", "debit", "credit", "purchase", "refund", "return", "returned", "online", "payment", "inc", "llc"]);
  /** A merchant, as a key a charge and its refund share: the first word that says something. */
  function merchantKey(t) {
    const words = String(t.merchant_name || t.name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
    return words[0] ?? "";
  }
  const TRANSFERISH = /transfer|xfer|payment|autopay|zelle|venmo|deposit|withdraw|ach|epay|online pmt|thank you/i;
  const looksLikeMove = t => t.category !== "INCOME" &&
    (/^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS)$/.test(t.category ?? "") || TRANSFERISH.test(`${t.name ?? ""} ${t.merchant_name ?? ""}`));
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

  /** rows: the selected transactions. Returns totals, by person and account, and the groups. */
  function summarize(rows, { refundDays = 120, transferDays = 5 } = {}) {
    const all = rows.map(t => ({ t, cents: Math.round(Number(t.amount) * 100), key: merchantKey(t) })).filter(x => x.cents !== 0);
    const out = all.filter(x => x.cents > 0), inn = all.filter(x => x.cents < 0);
    const sum = xs => xs.reduce((s, x) => s + Math.abs(x.cents), 0);
    const dates = all.map(x => x.t.date).sort();
    const by = (f, name) => {
      const m = new Map();
      for (const x of all) {
        const k = f(x.t), g = m.get(k) ?? { key: k, name: name(x.t), out: 0, in: 0, n: 0 };
        g[x.cents > 0 ? "out" : "in"] += Math.abs(x.cents); g.n++;
        m.set(k, g);
      }
      return [...m.values()].sort((a, b) => b.out + b.in - (a.out + a.in));
    };
    const totals = {
      n: all.length, out: sum(out), outN: out.length, in: sum(inn), inN: inn.length, net: sum(inn) - sum(out),
      from: dates[0] ?? null, to: dates.at(-1) ?? null,
      largest: out.reduce((m, x) => (!m || x.cents > m.cents ? x : m), null)?.t ?? null,
      average: out.length ? Math.round(sum(out) / out.length) : 0,
    };

    const used = new Set();
    const closest = (credit, pool, ok) => {
      let best = null;
      for (const c of pool) {
        if (used.has(c) || !ok(c)) continue;
        const d = Math.abs(days(c.t.date, credit.t.date));
        if (!best || d < best.d || (d === best.d && c.t.account_id === credit.t.account_id)) best = { c, d };
      }
      return best?.c ?? null;
    };
    const byAmount = new Map();
    for (const x of out) (byAmount.get(x.cents) ?? byAmount.set(x.cents, []).get(x.cents)).push(x);

    // 1. A charge and a refund of exactly the same amount, from the same merchant, up to refundDays later.
    const refunds = [];
    for (const r of [...inn].sort((a, b) => (a.t.date < b.t.date ? -1 : 1))) {
      if (!r.key) continue;
      const c = closest(r, byAmount.get(-r.cents) ?? [], c => c.key === r.key && days(c.t.date, r.t.date) >= 0 && days(c.t.date, r.t.date) <= refundDays);
      if (c) { used.add(c); used.add(r); refunds.push({ charge: c.t, refund: r.t, cents: c.cents, days: days(c.t.date, r.t.date) }); }
    }
    // 2. A move between two of the household's accounts: the same amount out of one and into another,
    //    within transferDays, where both sides read like a payment or transfer (never pay).
    const transfers = [];
    for (const r of inn) {
      if (used.has(r)) continue;
      const c = closest(r, byAmount.get(-r.cents) ?? [], c => c.t.account_id !== r.t.account_id && Math.abs(days(c.t.date, r.t.date)) <= transferDays && looksLikeMove(c.t) && looksLikeMove(r.t));
      if (c) { used.add(c); used.add(r); transfers.push({ from: c.t, to: r.t, cents: c.cents, days: Math.abs(days(c.t.date, r.t.date)) }); }
    }
    // 3. Merchants with charges and refunds left that don't pair exactly: refunded in part.
    const left = all.filter(x => !used.has(x));
    const groups = new Map();
    for (const x of left) if (x.key) (groups.get(x.key) ?? groups.set(x.key, []).get(x.key)).push(x);
    const partial = [];
    for (const xs of groups.values()) {
      const charged = sum(xs.filter(x => x.cents > 0)), refunded = sum(xs.filter(x => x.cents < 0));
      if (!charged || !refunded) continue;
      for (const x of xs) used.add(x);
      const first = xs.find(x => x.cents > 0).t;
      partial.push({ name: first.merchant_name || first.name, rows: xs.map(x => x.t), charged, refunded, open: charged - refunded });
    }
    partial.sort((a, b) => Math.abs(b.open) - Math.abs(a.open));
    // 4. What's left: charges nothing refunds, and money in nothing selected explains.
    const openCharges = all.filter(x => !used.has(x) && x.cents > 0).map(x => x.t);
    const openCredits = all.filter(x => !used.has(x) && x.cents < 0).map(x => x.t);
    return {
      totals,
      people: by(t => t.owner, t => t.owner),
      accounts: by(t => t.account_id, t => [t.institution_name, t.account_name].filter(Boolean).join(" · ") || "An account"),
      refunds, transfers, partial, openCharges, openCredits,
      openOut: openCharges.reduce((s, t) => s + Math.round(t.amount * 100), 0),
      openIn: -openCredits.reduce((s, t) => s + Math.round(t.amount * 100), 0),
    };
  }

  /** The rows as CSV, signed as the dashboard shows them (money in positive). */
  function csv(rows) {
    const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["date", "merchant", "description", "person", "account", "category", "amount", "pending", "tags"];
    return [head.join(","), ...[...rows].sort((a, b) => (a.date < b.date ? -1 : 1)).map(t => [
      t.date, t.merchant_name ?? "", t.name ?? "", t.owner, [t.institution_name, t.account_name].filter(Boolean).join(" · "), t.category ?? "",
      (-Number(t.amount)).toFixed(2), t.pending ? "yes" : "", (t.tags || []).join("; "),
    ].map(q).join(","))].join("\n") + "\n";
  }

  globalThis.MintyReconcile = { summarize, csv, merchantKey };
})();
