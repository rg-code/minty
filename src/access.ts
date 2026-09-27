import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

/** The login check. Cloudflare Access protects the whole hostname at the
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

/** Why jose refused the token, in terms of what the owner can fix. */
function rejection(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const claim = (e as { claim?: string })?.claim;
  if (code === "ERR_JWT_EXPIRED") return "forbidden: your Access session expired. Reload the page to sign in again.";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "aud") {
    return "forbidden: this sign-in is for a different Access application. " +
      "Check that ACCESS_AUD is the Application Audience (AUD) tag of this Worker's Access application.";
  }
  if ((code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "iss") ||
      code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
    return "forbidden: this sign-in is from a different Access team. Check ACCESS_TEAM_DOMAIN.";
  }
  return "forbidden: the Access sign-in isn't valid.";
}

function refuse(detail: string): AccessResult {
  console.warn(`access refused: ${detail}`);     // Workers Logs; never the token itself
  return { ok: false, detail };
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
    return refuse("Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)");
  }

  // Only requests that already passed Cloudflare Access at the edge get here, so the specific
  // reasons below go to signed-in people, not strangers.
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return refuse("forbidden: no Cloudflare Access sign-in on this request. Reload the page to sign in again.");

  let keys = getKey ?? jwksByTeam.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByTeam.set(issuer, keys);
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"] }));
  } catch (e) {
    return refuse(rejection(e));
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) return refuse("forbidden: this sign-in has no email (service tokens can't use Minty).");
  const allowed = new Set((env.ALLOWED_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (allowed.size && !allowed.has(email)) return refuse(`forbidden: ${email} is not in ALLOWED_LOGINS.`);
  return { ok: true, email };
}
