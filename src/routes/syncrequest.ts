import type { Env } from "../env";
import { json } from "../http";

/** Asking for a sync from the dashboard (clicking the logo). There is still no HTTP sync
 * endpoint: POST /sync-request only records the request, and the cron's next run (the 10-minute
 * catch-up at the latest) syncs every bank. So sync stays in the cron triggers, with their
 * budgets; no request path calls Plaid's sync. GET /sync-request: whether one is pending. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface SyncState { requested_at: string | null; last_sweep_at: string | null; last_synced_at?: string | null }

export async function syncState(env: Env): Promise<SyncState> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM app_state WHERE key IN ('sync_requested_at', 'last_sweep_at')").all<{ key: string; value: string }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value ?? null;
  return { requested_at: get("sync_requested_at"), last_sweep_at: get("last_sweep_at") };
}

export const isPending = (s: SyncState) => !!s.requested_at && (!s.last_sweep_at || s.last_sweep_at < s.requested_at);

/** The next run of the 10-minute catch-up trigger (*\/10 * * * *), as ISO time. */
export function nextCatchUp(now = new Date()): string {
  const t = new Date(now); t.setUTCSeconds(0, 0);
  t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 10) * 10 + 10);
  return t.toISOString();
}

const out = (s: SyncState) => ({ ...s, pending: isPending(s), runs_by: isPending(s) ? nextCatchUp() : null });

/** When Minty last saved data from Plaid: the most recent successful sync of any bank (~8 rows). */
async function lastSynced(env: Env): Promise<string | null> {
  const r = await env.DB.prepare(
    "SELECT max(updated_at) AS t FROM items WHERE status IN ('good', 'login_required') AND txn_cursor IS NOT NULL").first<{ t: string | null }>();
  return r?.t ?? null;
}

export async function getSyncRequest(env: Env): Promise<Response> {
  const [s, last] = await Promise.all([syncState(env), lastSynced(env)]);
  return json({ ...out(s), last_synced_at: last });
}

export async function requestSync(env: Env, email: string): Promise<Response> {
  const s = await syncState(env);
  if (isPending(s)) return json(out(s));            // already asked: one pending request, however many clicks
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('sync_requested_at', ${NOW}, ${NOW})
                    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
    env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('sync_requested_by', ?, ${NOW})
                    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(email),
  ]);
  const [s2, last] = await Promise.all([syncState(env), lastSynced(env)]);
  return json({ ...out(s2), last_synced_at: last });
}

/** Called by the cron after a full sweep of every bank. */
export async function markSwept(env: Env): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('last_sweep_at', ${NOW}, ${NOW})
                        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run();
}
