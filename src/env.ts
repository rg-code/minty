/** Worker bindings and settings. Plain settings come from wrangler.jsonc "vars"; secrets from
 * `wrangler secret put` (deployed) or .dev.vars (local). Per-person Plaid keys are dynamic:
 * PLAID_CLIENT_ID_<KEY>_<SLOT> / PLAID_SECRET_<KEY>_<SLOT>, hence the index signature. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Rate limits per login (wrangler.jsonc "ratelimits"). Missing = not limited (src/limits.ts). */
  RL_GENERAL?: RateLimit;
  RL_SEARCH?: RateLimit;
  RL_LINK?: RateLimit;

  MINTY_USERS?: string;
  /** Plaid credential slots per person, in overflow order. Default "primary,backup". */
  PLAID_SLOTS?: string;
  PLAID_ENV?: string;
  PLAID_REDIRECT_URI?: string;
  TRIAL_ITEM_CAP?: string;
  /** Plaid pages synced per cron run (each = 1 Plaid call + 1 D1 batch). Default 10. */
  SYNC_MAX_PAGES_PER_RUN?: string;
  /** Page text synced per cron run, in bytes. Default 150,000 (median ~8 ms CPU measured; free plan allows 10). */
  SYNC_MAX_BYTES_PER_RUN?: string;
  /** D1 rows the pages may read per UTC day before heavy routes pause. Default 3,000,000; "0" = off. */
  READ_BUDGET_PER_DAY?: string;

  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_LOGINS?: string;
  /** Local development only (.dev.vars). Skips Access, and only for localhost requests. */
  MINTY_DEV_NO_AUTH?: string;

  TOKEN_ENC_KEY?: string;
  /** Only while changing the key (src/token-key.ts): the old TOKEN_ENC_KEY, which still opens the
   * tokens saved under it until each is saved again under the new one. */
  TOKEN_ENC_KEY_PREVIOUS?: string;
  /** "off": never ask irs.gov for the contribution limits (src/retirement/irs.ts). Default on. */
  IRS_LIMITS?: string;
  /** Kos K2 (src/immich.ts): the household's Immich, as the Worker reaches it (a public address, e.g. a
   * Cloudflare Tunnel's hostname). Unset: no photos in Kos, and nothing about Immich runs. */
  IMMICH_URL?: string;
  /** Where people open Immich in a browser (e.g. its tailnet address), for the album's link. Default IMMICH_URL. */
  IMMICH_LINK_URL?: string;
  /** Secret: an Immich API key with asset.read, asset.view, album.read, album.create, albumAsset.create. */
  IMMICH_API_KEY?: string;
  /** Secrets, only when Immich's address is behind Cloudflare Access: a service token's id and secret. */
  IMMICH_ACCESS_CLIENT_ID?: string;
  IMMICH_ACCESS_CLIENT_SECRET?: string;
  /** Secret: a LocationIQ access token (src/geocode.ts), for Kos bookings' exact places. Unset: no lookups. */
  LOCATIONIQ_KEY?: string;
  /** Kos live flight status and flight look-up (src/flights.ts): "aeroapi" (the default; the only one yet). */
  FLIGHT_STATUS_PROVIDER?: string;
  /** Secret: the provider's key (a FlightAware AeroAPI Personal key). Unset: no flight status or look-up. */
  FLIGHT_STATUS_KEY?: string;
  /** Calls to the provider a UTC day at most, the cron's and the look-ups' together. Default 50. */
  FLIGHT_STATUS_CALLS_PER_DAY?: string;

  [key: string]: unknown;
}
