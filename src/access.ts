import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

/** Replaces the Tailscale identity gate. Cloudflare Access protects the whole hostname at the
 * edge; because static assets sit behind Cloudflare's internal router, the Worker doesn't get
 * ctx.access, so every API request re-validates the Access JWT itself.
 * Fail closed: if ACCESS_TEAM_DOMAIN / ACCESS_AUD are unset, nothing gets through. */

export type AccessResult = { ok: true; email: string } | { ok: false; detail: string };

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

/** Tests: use a local key set for an issuer instead of fetching <team>/cdn-cgi/access/certs. */
export function primeJwks(issuer: string, keys: JWTVerifyGetKey): void {
  jwksByTeam.set(issuer, keys);
}

/** "team", "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/" -> issuer URL. */
export function teamIssuer(raw: string | undefined): string | null {
  let s = (raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "");
  if (!s.includes(".")) s = `${s}.cloudflareaccess.com`;
  return `https://${s}`;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export async function checkAccess(request: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<AccessResult> {
  if (env.MINTY_DEV_NO_AUTH === "1") {
    // Local `npm run dev` convenience (passed with --var, never stored). Refused for real hostnames.
    return isLocalhost(new URL(request.url).hostname)
      ? { ok: true, email: "dev@localhost" }
      : { ok: false, detail: "MINTY_DEV_NO_AUTH is only honoured on localhost" };
  }

  const issuer = teamIssuer(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD?.trim();
  if (!issuer || !audience) {
    return { ok: false, detail: "Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)" };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, detail: "forbidden" };

  let keys = getKey ?? jwksByTeam.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByTeam.set(issuer, keys);
  }

  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"] });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return { ok: false, detail: "forbidden" };        // e.g. service tokens: not a person
    const allowed = new Set((env.ALLOWED_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (allowed.size && !allowed.has(email)) return { ok: false, detail: "forbidden" };
    return { ok: true, email };
  } catch {
    return { ok: false, detail: "forbidden" };
  }
}
