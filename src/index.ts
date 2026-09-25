import type { Env } from "./env";
import { checkAccess } from "./access";
import { ConfigError, loadConfig, type Config } from "./config";
import { HttpError, json, unprocessable } from "./http";
import * as data from "./routes/data";
import * as link from "./routes/link";
import * as setup from "./routes/status";
import { PlaidError } from "./plaid";
import { runSyncAll } from "./sync";

/** Minty Worker. API paths are listed in wrangler.jsonc assets.run_worker_first; everything
 * else is served straight from app/static. /healthz is the only path outside the Access check.
 * Sync runs only from the cron trigger (scheduled below); there is deliberately no HTTP sync endpoint. */

type Handler = (c: {
  env: Env; config: Config; request: Request; url: URL; params: string[]; ctx: ExecutionContext; email: string;
}) => Promise<Response>;

const ROUTES: Array<[method: string, path: RegExp, handler: Handler]> = [
  ["GET", /^\/status$/, ({ env, config, email }) => setup.status(env, config, email)],
  ["GET", /^\/users$/, ({ env, config }) => data.users(env, config)],
  ["GET", /^\/items$/, ({ env }) => data.items(env)],
  ["GET", /^\/accounts$/, ({ env, url }) => data.accounts(env, url)],
  ["GET", /^\/capacity$/, ({ env, config }) => data.capacity(env, config)],
  ["GET", /^\/transactions$/, ({ env, url }) => data.transactions(env, url)],
  ["GET", /^\/tags$/, ({ env }) => data.listTags(env)],
  ["PUT", /^\/transactions\/([^/]+)\/tags$/, ({ env, request, params }) => {
    if (!/^\d+$/.test(params[0])) throw unprocessable("transaction id must be an integer");
    return data.setTags(env, request, Number(params[0]));
  }],
  ["POST", /^\/link\/token$/, ({ env, config, request }) => link.createLinkToken(env, config, request)],
  ["POST", /^\/link\/exchange$/, ({ env, config, request, ctx }) => link.exchange(env, config, request, ctx)],
  ["POST", /^\/link\/token\/update$/, ({ env, config, request }) => link.updateMode(env, config, request)],
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });

    // Not an API route: a static file (or its 404). Those are the public pages from app/static
    // and carry no data; Access still guards the hostname at the edge.
    const matches = ROUTES.map(([m, re, h]) => [m, url.pathname.match(re), h] as const).filter(([, m]) => m);
    if (!matches.length) return env.ASSETS.fetch(request);

    const auth = await checkAccess(request, env);
    if (!auth.ok) return json({ detail: auth.detail }, 403);

    const hit = matches.find(([m]) => m === request.method);
    if (!hit) return json({ detail: "method not allowed" }, 405);

    try {
      const config = loadConfig(env);
      return await hit[2]({ env, config, request, url, params: hit[1]!.slice(1), ctx, email: auth.email });
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      if (e instanceof ConfigError) return json({ detail: e.message }, 500);
      if (e instanceof PlaidError) {
        console.error(`plaid error ${e.errorCode} (request ${e.requestId ?? "?"})`);
        return json({ detail: `Plaid error: ${e.errorCode}` }, 502);
      }
      console.error("unhandled error", e instanceof Error ? e.message : e);   // never log request bodies
      return json({ detail: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const results = await runSyncAll(env);
    console.log("scheduled sync complete", JSON.stringify(results));   // item id -> result; no data
  },
} satisfies ExportedHandler<Env>;
