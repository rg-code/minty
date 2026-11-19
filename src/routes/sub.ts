import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { ACCOUNT_NAME } from "../accounts";
import { PROGRAMS, PROGRAM_BY_ID } from "../points/programs";
import { NOT_SPEND, type Payout, accountHolding, holding, payoutCandidates, requirementState } from "../sub/rules";

/** SUB, sign-up bonuses (docs/sub.md): offers, their requirements and payouts, which the household
 * writes and sync never does. GET /sub adds progress estimated from the linked account's own
 * transactions: one query per requirement, by account and date (idx_txn_account_date), bounded at
 * both ends. Nothing here changes a balance, net worth or a transaction. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_TERMS = 8000;
const NOT_SPEND_SQL = NOT_SPEND.map((c) => `'${c}'`).join(", ");
const FEED_STALE_DAYS = 3;          // a bank whose sync is older than this is "can't tell yet"

// --- validation -----------------------------------------------------------------------------
type Body = Record<string, unknown>;
const body = async (request: Request): Promise<Body> => {
  const b = await jsonBody(request);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Body;
};
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const text = (b: Body, k: string, max: number, old?: unknown): string | null => {
  if (!(k in b)) return (old as string | null | undefined) ?? null;
  const v = b[k];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw unprocessable(`${k} must be text`);
  const t = k === "terms_text" || k === "notes" || k === "rule_text" ? v.trim() : v.replace(/\s+/g, " ").trim();
  if (t.length > max) throw unprocessable(`${k} must be at most ${max.toLocaleString("en-US")} characters`);
  return t || null;
};
const date = (b: Body, k: string, old?: unknown): string | null => {
  if (!(k in b)) return (old as string | null | undefined) ?? null;
  const v = b[k];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !isDate(v)) throw unprocessable(`${k} must be a date, YYYY-MM-DD`);
  return v;
};
const int = (b: Body, k: string, min: number, max: number, old?: unknown): number | null => {
  if (!(k in b)) return (old as number | null | undefined) ?? null;
  const v = b[k];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw unprocessable(`${k} must be a whole number from ${min} to ${max}`);
  return v;
};
const oneOf = <T extends string>(b: Body, k: string, allowed: readonly T[], old?: unknown): T | null => {
  if (!(k in b)) return (old as T | null | undefined) ?? null;
  const v = b[k];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw unprocessable(`${k} must be one of ${allowed.join(", ")}`);
  return v as T;
};
const MAX_CENTS = 1e11;

const STATUSES = ["planned", "applied", "open", "met", "paid", "closed", "lost"] as const;
const KINDS = ["card", "bank", "brokerage", "other"] as const;
const TRIGGERS = ["opened", "first_payout", "last_payout", "date"] as const;
const REQ_KINDS = ["spend", "deposits", "direct_deposits", "balance", "transactions", "other"] as const;

interface OfferRow { [k: string]: unknown; id: number; owner: string; account_id: number | null; status: string; opened_date: string | null; reward_cents: number | null }

async function offerFields(env: Env, config: Config, b: Body, old: OfferRow | null) {
  const owner = "owner" in b ? b.owner : old?.owner;
  if (typeof owner !== "string" || !config.users.has(owner)) throw unprocessable("owner must be one of the household's people (MINTY_USERS)");
  const account_id = int(b, "account_id", 1, Number.MAX_SAFE_INTEGER, old?.account_id);
  if (account_id !== null && !(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account_id).first())) throw unprocessable("no account with that id");
  const f = {
    owner, account_id,
    kind: oneOf(b, "kind", KINDS, old?.kind) ?? "card",
    institution: text(b, "institution", 80, old?.institution),
    product: text(b, "product", 100, old?.product),
    status: oneOf(b, "status", STATUSES, old?.status) ?? "open",
    reward_cents: int(b, "reward_cents", 0, MAX_CENTS, old?.reward_cents),
    reward_points: int(b, "reward_points", 0, 1e9, old?.reward_points),
    reward_program: text(b, "reward_program", 40, old?.reward_program),
    opened_date: date(b, "opened_date", old?.opened_date),
    expected_payout_date: date(b, "expected_payout_date", old?.expected_payout_date),
    rule_trigger: oneOf(b, "rule_trigger", TRIGGERS, old?.rule_trigger),
    rule_trigger_date: date(b, "rule_trigger_date", old?.rule_trigger_date),
    rule_length: int(b, "rule_length", 1, 3660, old?.rule_length),
    rule_unit: oneOf(b, "rule_unit", ["days", "months"] as const, old?.rule_unit),
    rule_text: text(b, "rule_text", 1000, old?.rule_text),
    keep_open_until: date(b, "keep_open_until", old?.keep_open_until),
    keep_open_reason: text(b, "keep_open_reason", 300, old?.keep_open_reason),
    annual_fee_cents: int(b, "annual_fee_cents", 0, 1e7, old?.annual_fee_cents),
    fee_date: date(b, "fee_date", old?.fee_date),
    terms_url: text(b, "terms_url", 500, old?.terms_url),
    terms_text: text(b, "terms_text", MAX_TERMS, old?.terms_text),
    terms_sha256: text(b, "terms_sha256", 64, old?.terms_sha256),
    notes: text(b, "notes", 2000, old?.notes),
  };
  if (f.reward_program && !PROGRAM_BY_ID.has(f.reward_program)) throw unprocessable("reward_program must be one of BAM's programs");
  if (f.terms_url && !/^https?:\/\/\S+$/i.test(f.terms_url)) throw unprocessable("terms_url must be an http(s) link");
  if (f.terms_sha256 && !/^[0-9a-f]{64}$/.test(f.terms_sha256)) throw unprocessable("terms_sha256 must be a SHA-256 in hex");
  if (f.keep_open_until && !f.keep_open_reason) throw unprocessable("a keep-open date you give needs its reason (keep_open_reason)");
  if (f.rule_trigger === "date" && !f.rule_trigger_date) throw unprocessable("a rule that starts on a date needs rule_trigger_date");
  if ((f.rule_trigger || f.rule_length || f.rule_unit) && !(f.rule_trigger && f.rule_length && f.rule_unit)) {
    throw unprocessable("a holding rule needs its trigger, length and unit (or none of them)");
  }
  return f;
}

const COLS = ["owner", "account_id", "kind", "institution", "product", "status", "reward_cents", "reward_points", "reward_program", "opened_date",
  "expected_payout_date", "rule_trigger", "rule_trigger_date", "rule_length", "rule_unit", "rule_text", "keep_open_until", "keep_open_reason",
  "annual_fee_cents", "fee_date", "terms_url", "terms_text", "terms_sha256", "notes"] as const;

// --- offers -----------------------------------------------------------------------------------
export async function saveOffer(env: Env, config: Config, request: Request, id?: number): Promise<Response> {
  const old = id === undefined ? null : await env.DB.prepare("SELECT * FROM sub_offers WHERE id = ?").bind(id).first<OfferRow>();
  if (id !== undefined && !old) throw new HttpError(404, "offer not found");
  const f = await offerFields(env, config, await body(request), old);
  const values = COLS.map((c) => f[c]);
  if (!old) {
    const r = await env.DB.prepare(`INSERT INTO sub_offers (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")}) RETURNING id`)
      .bind(...values).first<{ id: number }>();
    return json({ id: r!.id }, 201);
  }
  await env.DB.prepare(`UPDATE sub_offers SET ${COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ${NOW} WHERE id = ?`).bind(...values, id).run();
  return json({ id });
}

export async function deleteOffer(env: Env, id: number): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM sub_offers WHERE id = ? RETURNING id").bind(id).first();
  if (!r) throw new HttpError(404, "offer not found");
  return json({ id, removed: true });
}

// --- requirements and payouts -------------------------------------------------------------
const offerExists = async (env: Env, id: unknown) => {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || !(await env.DB.prepare("SELECT 1 FROM sub_offers WHERE id = ?").bind(id).first())) {
    throw unprocessable("offer_id must be one of SUB's offers");
  }
  return id;
};

export async function saveRequirement(env: Env, request: Request, id?: number): Promise<Response> {
  const old = id === undefined ? null : await env.DB.prepare("SELECT * FROM sub_requirements WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (id !== undefined && !old) throw new HttpError(404, "requirement not found");
  const b = await body(request);
  const offer_id = old ? old.offer_id as number : await offerExists(env, b.offer_id);
  const kind = oneOf(b, "kind", REQ_KINDS, old?.kind);
  if (!kind) throw unprocessable(`kind must be one of ${REQ_KINDS.join(", ")}`);
  const f = { kind, target_cents: int(b, "target_cents", 0, MAX_CENTS, old?.target_cents), target_count: int(b, "target_count", 1, 1000, old?.target_count),
              start_date: date(b, "start_date", old?.start_date), deadline: date(b, "deadline", old?.deadline), done_at: date(b, "done_at", old?.done_at),
              note: text(b, "note", 300, old?.note) };
  if (old) {
    await env.DB.prepare(`UPDATE sub_requirements SET kind = ?, target_cents = ?, target_count = ?, start_date = ?, deadline = ?, done_at = ?, note = ? WHERE id = ?`)
      .bind(f.kind, f.target_cents, f.target_count, f.start_date, f.deadline, f.done_at, f.note, id).run();
    return json({ id });
  }
  const r = await env.DB.prepare(`INSERT INTO sub_requirements (offer_id, kind, target_cents, target_count, start_date, deadline, done_at, note)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(offer_id, f.kind, f.target_cents, f.target_count, f.start_date, f.deadline, f.done_at, f.note).first<{ id: number }>();
  return json({ id: r!.id }, 201);
}

export async function savePayout(env: Env, request: Request, id?: number): Promise<Response> {
  const old = id === undefined ? null : await env.DB.prepare("SELECT * FROM sub_payouts WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (id !== undefined && !old) throw new HttpError(404, "payout not found");
  const b = await body(request);
  const offer_id = old ? old.offer_id as number : await offerExists(env, b.offer_id);
  const f = { date: date(b, "date", old?.date), amount_cents: int(b, "amount_cents", 0, MAX_CENTS, old?.amount_cents),
              points: int(b, "points", 0, 1e9, old?.points), transaction_id: int(b, "transaction_id", 1, Number.MAX_SAFE_INTEGER, old?.transaction_id),
              note: text(b, "note", 300, old?.note) };
  if (f.date === null && f.amount_cents === null && f.points === null) throw unprocessable("a payout needs its date, amount or points (one may be unknown, not all)");
  if (f.transaction_id !== null && !(await env.DB.prepare("SELECT 1 FROM transactions WHERE id = ?").bind(f.transaction_id).first())) {
    throw unprocessable("no transaction with that id");
  }
  if (old) {
    await env.DB.prepare("UPDATE sub_payouts SET date = ?, amount_cents = ?, points = ?, transaction_id = ?, note = ? WHERE id = ?")
      .bind(f.date, f.amount_cents, f.points, f.transaction_id, f.note, id).run();
    return json({ id });
  }
  const r = await env.DB.prepare("INSERT INTO sub_payouts (offer_id, date, amount_cents, points, transaction_id, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(offer_id, f.date, f.amount_cents, f.points, f.transaction_id, f.note).first<{ id: number }>();
  return json({ id: r!.id }, 201);
}

export async function deleteChild(env: Env, table: "sub_requirements" | "sub_payouts", id: number): Promise<Response> {
  const r = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? RETURNING id`).bind(id).first();
  if (!r) throw new HttpError(404, "not found");
  return json({ id, removed: true });
}

// --- GET /sub ---------------------------------------------------------------------------------
// What a requirement's window holds on its account: spend (purchases less refunds, without
// payments, transfers, fees, interest or money in), pending spend apart, money in, direct deposits
// (Plaid's INCOME), and purchases counted. The window is bounded at both ends.
const WINDOW = `
  SELECT coalesce(sum(CASE WHEN pending = 0 AND coalesce(category, '') NOT IN (${NOT_SPEND_SQL}) THEN amount_cents ELSE 0 END), 0) AS spent,
         coalesce(sum(CASE WHEN pending = 1 AND amount_cents > 0 AND coalesce(category, '') NOT IN (${NOT_SPEND_SQL}) THEN amount_cents ELSE 0 END), 0) AS pending_spend,
         coalesce(sum(CASE WHEN pending = 0 AND amount_cents < 0 AND coalesce(category, '') <> 'LOAN_PAYMENTS' THEN -amount_cents ELSE 0 END), 0) AS deposits,
         count(CASE WHEN pending = 0 AND amount_cents < 0 AND coalesce(category, '') <> 'LOAN_PAYMENTS' THEN 1 END) AS deposit_count,
         coalesce(sum(CASE WHEN pending = 0 AND amount_cents < 0 AND category = 'INCOME' THEN -amount_cents ELSE 0 END), 0) AS direct,
         count(CASE WHEN pending = 0 AND amount_cents < 0 AND category = 'INCOME' THEN 1 END) AS direct_count,
         count(CASE WHEN pending = 0 AND amount_cents > 0 AND coalesce(category, '') NOT IN (${NOT_SPEND_SQL}) THEN 1 END) AS purchases
  FROM transactions WHERE account_id = ?1 AND date >= ?2 AND date <= ?3`;
// Credits that might be the bonus, from opening to 18 months on (bounded both ends).
const CANDIDATES = `
  SELECT id, date, amount_cents, coalesce(merchant_name, name) AS name FROM transactions
  WHERE account_id = ?1 AND date >= ?2 AND date <= date(?2, '+18 months') AND amount_cents < 0 AND pending = 0
    AND (lower(name) LIKE '%bonus%' OR lower(name) LIKE '%reward%' OR lower(coalesce(merchant_name, '')) LIKE '%bonus%')
  ORDER BY date LIMIT 10`;

interface Window { spent: number; pending_spend: number; deposits: number; deposit_count: number; direct: number; direct_count: number; purchases: number }

export async function list(env: Env, url: URL): Promise<Response> {
  const today = url.searchParams.get("today");
  const day = today && isDate(today) ? today : new Date().toISOString().slice(0, 10);   // the browser's own date, else UTC's
  const [offers, reqs, pays] = await env.DB.batch([
    env.DB.prepare(`SELECT o.*, ${ACCOUNT_NAME("a")} AS account_name, a.mask AS account_mask, a.type AS account_type,
                           i.status AS bank_status, i.updated_at AS bank_synced_at, i.products AS bank_products
                    FROM sub_offers o LEFT JOIN accounts a ON a.id = o.account_id LEFT JOIN items i ON i.id = a.item_id
                    ORDER BY o.created_at`),
    env.DB.prepare("SELECT * FROM sub_requirements ORDER BY offer_id, coalesce(deadline, '9999'), id"),
    env.DB.prepare("SELECT * FROM sub_payouts ORDER BY offer_id, coalesce(date, '9999'), id"),
  ]);
  const O = offers.results as (OfferRow & { bank_status: string | null; bank_synced_at: string | null; bank_products: string | null })[];
  const R = reqs.results as { id: number; offer_id: number; kind: string; target_cents: number | null; target_count: number | null; start_date: string | null; deadline: string | null; done_at: string | null }[];
  const P = pays.results as ({ id: number; offer_id: number; transaction_id: number | null } & Payout)[];

  // the windows to read: requirements that can be estimated, on an offer with an account and a start
  const MEASURED = new Set(["spend", "deposits", "direct_deposits", "transactions"]);
  const windows: { req: number; account: number; from: string; to: string }[] = [];
  for (const r of R) {
    const o = O.find((x) => x.id === r.offer_id);
    const from = r.start_date ?? o?.opened_date;
    if (!o?.account_id || !from || !MEASURED.has(r.kind)) continue;
    const to = r.deadline && r.deadline < day ? r.deadline : day;
    if (to >= from) windows.push({ req: r.id, account: o.account_id, from, to });
  }
  // payouts worth looking for: a cash reward, on a linked account that's open (points aren't in the feed)
  const candidateOffers = O.filter((o) => o.account_id && o.opened_date && o.reward_cents && ["open", "met", "paid"].includes(o.status));
  const stmts = [...windows.map((w) => env.DB.prepare(WINDOW).bind(w.account, w.from, w.to)),
                 ...candidateOffers.map((o) => env.DB.prepare(CANDIDATES).bind(o.account_id, o.opened_date))];
  const res = stmts.length ? await env.DB.batch(stmts) : [];            // D1 refuses an empty batch
  const windowOf = new Map(windows.map((w, i) => [w.req, res[i].results[0] as unknown as Window]));
  const linked = new Set(P.map((p) => p.transaction_id).filter((x): x is number => x !== null));
  const candidatesOf = new Map(candidateOffers.map((o, i) => [o.id,
    payoutCandidates((res[windows.length + i].results as { id: number; date: string; amount_cents: number; name: string }[]).filter((t) => !linked.has(t.id)), o.reward_cents)]));

  const staleBefore = new Date(Date.parse(`${day}T00:00:00Z`) - FEED_STALE_DAYS * 864e5).toISOString();
  const out = O.map((o) => {
    const payouts = P.filter((p) => p.offer_id === o.id);
    const feedCurrent = o.account_id !== null && o.bank_products !== "manual" && o.bank_status === "good" && (o.bank_synced_at ?? "") >= staleBefore;
    const requirements = R.filter((r) => r.offer_id === o.id).map((r) => {
      const w = windowOf.get(r.id);
      const progress = !w ? null
        : r.kind === "spend" ? { done: w.spent, target: r.target_cents, count: w.purchases, target_count: r.target_count, pending: w.pending_spend }
        : r.kind === "deposits" ? { done: w.deposits, target: r.target_cents, count: w.deposit_count, target_count: r.target_count, pending: 0 }
        : r.kind === "direct_deposits" ? { done: w.direct, target: r.target_cents, count: w.direct_count, target_count: r.target_count, pending: 0 }
        : { done: 0, target: null, count: w.purchases, target_count: r.target_count, pending: 0 };
      return { ...r, progress, state: requirementState(r, progress, day, feedCurrent) };
    });
    const { bank_status, bank_synced_at, bank_products, ...rest } = o;
    return { ...rest, feed_current: feedCurrent, requirements, payouts, holding: holding(o as never, payouts, day), payout_candidates: candidatesOf.get(o.id) ?? [] };
  });
  // the account-wide holding state, for accounts with several offers
  const byAccount: Record<string, ReturnType<typeof accountHolding>> = {};
  for (const id of new Set(out.map((o) => o.account_id).filter((x): x is number => x !== null))) {
    byAccount[id] = accountHolding(out.filter((o) => o.account_id === id && o.status !== "lost").map((o) => o.holding));
  }
  return json({ today: day, offers: out, accounts: byAccount, programs: PROGRAMS.map((p) => ({ id: p.id, name: p.name, unit: p.unit })) });
}
