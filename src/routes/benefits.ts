import type { Env } from "../env";
import { HttpError, intParam, json, unprocessable } from "../http";
import { CHECKED, NOT_TRACKED, PRODUCTS, productById } from "../benefits/catalog";
import { type CardRow, MERCHANT_HIT, type TxnRow, allPatterns, compute, periodStart, productFor, tag } from "../benefits/engine";

/** ABC ("All but coupon clipping"): GET /benefits, the household's card credits for a year;
 * PUT /benefits/cards/:id, a card's product / card-year month / hidden; PUT /benefits/marks,
 * ticks for credits Minty can't see on a statement. */

// The catalog's patterns as one bound JSON array, so SQLite returns only credits, qualifying
// purchases and evidence rows: a few hundred, not every transaction. (One OR per pattern would
// exceed SQLite's expression-depth limit of 100.)
// Each row comes back with the patterns it matched (see TxnRow.hits), so the Worker does no
// string matching: on a cold isolate that alone would use up the 10 ms CPU allowance.
const PATTERNS = JSON.stringify(allPatterns());
const TAGGED = `
  SELECT t.id, t.account_id, t.date, t.amount_cents, t.name, t.merchant_name,
         group_concat(CASE WHEN t.name LIKE p.value THEN p.key ELSE p.key + ${MERCHANT_HIT} END) AS hits
  FROM transactions t JOIN accounts a ON a.id = t.account_id
  JOIN json_each(?) p ON t.name LIKE p.value OR t.merchant_name LIKE p.value`;

const today = () => new Date().toISOString().slice(0, 10);

export async function benefits(env: Env, url: URL): Promise<Response> {
  const now = today();
  const thisYear = Number(now.slice(0, 4));
  const year = intParam(url, "year", { def: thisYear, min: 2000, max: thisYear + 1 })!;

  const [cards, rows, fees, since, marks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT a.id, a.owner, i.institution_name AS bank, a.name, a.mask,
              cp.product_id, cp.anniversary_month, coalesce(cp.hidden, 0) AS hidden
       FROM accounts a JOIN items i ON i.id = a.item_id LEFT JOIN card_products cp ON cp.account_id = a.id
       WHERE a.type = 'credit' ORDER BY a.owner, i.id, a.name, a.id`),
    env.DB.prepare(`${TAGGED} WHERE a.type = 'credit' AND t.pending = 0 GROUP BY t.id`).bind(PATTERNS),
    env.DB.prepare(
      `SELECT t.account_id, min(t.date) AS date FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.type = 'credit' AND t.amount_cents >= 0 AND t.name NOT LIKE '%REFUND%'
         AND (t.name LIKE '%MEMBERSHIP FEE%' OR t.name LIKE '%ANNUAL FEE%')
       GROUP BY t.account_id`),
    env.DB.prepare(
      `SELECT t.account_id, min(t.date) AS date FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.type = 'credit' GROUP BY t.account_id`),
    env.DB.prepare("SELECT account_id, benefit_id, period_start FROM benefit_marks"),
  ]);
  const byAccount = (r: { account_id: number; date: string }[]) => new Map(r.map((x) => [x.account_id, x.date]));
  const result = compute({
    year, today: now,
    cards: cards.results as unknown as CardRow[],
    rows: rows.results as unknown as TxnRow[],
    firstFee: byAccount(fees.results as any),
    dataSince: byAccount(since.results as any),
    marks: new Set((marks.results as { account_id: number; benefit_id: string; period_start: string }[])
      .map((m) => `${m.account_id}|${m.benefit_id}|${m.period_start}`)),
  });
  return json({
    year, today: now, checked: CHECKED, not_tracked: NOT_TRACKED,
    products: PRODUCTS.map((p) => ({ id: p.id, name: p.name })),
    ...result,
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fall through */ }
  throw unprocessable("body must be a JSON object");
}

async function creditCard(env: Env, accountId: number): Promise<CardRow> {
  const card = await env.DB.prepare(
    `SELECT a.id, a.owner, i.institution_name AS bank, a.name, a.mask, cp.product_id, cp.anniversary_month,
            coalesce(cp.hidden, 0) AS hidden
     FROM accounts a JOIN items i ON i.id = a.item_id LEFT JOIN card_products cp ON cp.account_id = a.id
     WHERE a.id = ? AND a.type = 'credit'`).bind(accountId).first<CardRow>();
  if (!card) throw new HttpError(404, "credit card not found");
  return card;
}

/** PUT /benefits/cards/:id {product_id?: string | null, anniversary_month?: 1–12 | null, hidden?: boolean}.
 * product_id null = recognise it automatically; "none" = it has no tracked credits. */
export async function setCard(env: Env, request: Request, accountId: number): Promise<Response> {
  const b = await body(request);
  const card = await creditCard(env, accountId);
  let product = card.product_id, month = card.anniversary_month, hidden = !!card.hidden;
  if ("product_id" in b) {
    if (b.product_id !== null && (typeof b.product_id !== "string" || (b.product_id !== "none" && !productById.has(b.product_id)))) {
      throw unprocessable("product_id must be null, \"none\" or a known product");
    }
    product = b.product_id as string | null;
  }
  if ("anniversary_month" in b) {
    if (b.anniversary_month !== null && !(Number.isInteger(b.anniversary_month) && (b.anniversary_month as number) >= 1 && (b.anniversary_month as number) <= 12)) {
      throw unprocessable("anniversary_month must be null or 1–12");
    }
    month = b.anniversary_month as number | null;
  }
  if ("hidden" in b) {
    if (typeof b.hidden !== "boolean") throw unprocessable("hidden must be true or false");
    hidden = b.hidden;
  }
  await env.DB.prepare(
    `INSERT INTO card_products (account_id, product_id, anniversary_month, hidden) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET product_id = excluded.product_id, anniversary_month = excluded.anniversary_month,
       hidden = excluded.hidden, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(accountId, product, month, hidden ? 1 : 0).run();
  return json({ account_id: accountId, product_id: product, anniversary_month: month, hidden });
}

/** PUT /benefits/marks {account_id, benefit_id, period_start, used}: tick (or untick) a credit
 * Minty can't see on a statement, for one period. */
export async function setMark(env: Env, request: Request, email: string): Promise<Response> {
  const b = await body(request);
  if (!Number.isInteger(b.account_id)) throw unprocessable("account_id must be an integer");
  if (typeof b.benefit_id !== "string") throw unprocessable("benefit_id must be a string");
  if (typeof b.period_start !== "string" || !/^\d{4}-\d{2}-01$/.test(b.period_start) || Number.isNaN(Date.parse(b.period_start))) {
    throw unprocessable("period_start must be a period's first day (YYYY-MM-01)");
  }
  if (typeof b.used !== "boolean") throw unprocessable("used must be true or false");
  const card = await creditCard(env, b.account_id as number);
  const rows = (await env.DB.prepare(`${TAGGED} WHERE t.account_id = ? GROUP BY t.id`).bind(PATTERNS, card.id).all<TxnRow>()).results;
  const { product } = productFor(card, rows.map(tag));
  const benefit = product?.benefits.find((x) => x.id === b.benefit_id);
  if (!benefit) throw new HttpError(404, "this card has no such credit");
  if (benefit.how !== "outside") throw unprocessable("only credits Minty can't see on a statement can be ticked");
  if (periodStart(b.period_start as string, benefit, 1) !== b.period_start) throw unprocessable(`${b.period_start} doesn't start a period of this credit`);
  await (b.used
    ? env.DB.prepare(
        `INSERT INTO benefit_marks (account_id, benefit_id, period_start, marked_by) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`).bind(card.id, benefit.id, b.period_start, email)
    : env.DB.prepare("DELETE FROM benefit_marks WHERE account_id = ? AND benefit_id = ? AND period_start = ?")
        .bind(card.id, benefit.id, b.period_start)).run();
  return json({ account_id: card.id, benefit_id: benefit.id, period_start: b.period_start, used: b.used });
}
