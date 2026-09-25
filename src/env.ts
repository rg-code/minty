/** Worker bindings and settings. Plain settings come from wrangler.jsonc "vars"; secrets from
 * `wrangler secret put` (deployed) or .dev.vars (local). Per-person Plaid keys are dynamic:
 * PLAID_CLIENT_ID_<KEY>_<SLOT> / PLAID_SECRET_<KEY>_<SLOT>, hence the index signature. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  MINTY_USERS?: string;
  PLAID_ENV?: string;
  PLAID_REDIRECT_URI?: string;
  TRIAL_ITEM_CAP?: string;
  /** Plaid pages synced per cron run (each = 1 Plaid call + 1 D1 batch). Default 10. */
  SYNC_MAX_PAGES_PER_RUN?: string;

  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_LOGINS?: string;
  /** Local development only (.dev.vars). Skips Access, and only for localhost requests. */
  MINTY_DEV_NO_AUTH?: string;

  TOKEN_ENC_KEY?: string;

  [key: string]: unknown;
}
