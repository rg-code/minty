// `npm run deploy` — what Cloudflare Workers Builds runs on every push to your fork's main.
//
// Normal deploy: apply pending D1 migrations first, then deploy the code that needs them.
// First deploy: the D1 database doesn't exist yet and is created by `wrangler deploy`
// (automatic provisioning, by database_name in wrangler.jsonc), so deploy first, then migrate.
// Migrations are tracked in d1_migrations, so re-running this is safe.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

// Extra flags are passed to every wrangler call, e.g. `npm run deploy -- --temporary`.
const EXTRA = process.argv.slice(2);

function wrangler(...args) {
  const r = spawnSync("npx", ["wrangler", ...args, ...EXTRA], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  return { ok: r.status === 0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function must(result, what) {
  if (!result.ok) {
    console.error(`\ndeploy: ${what} failed (see above).`);
    process.exit(1);
  }
}

// Kos's attachments need R2 (docs/trips.md §38). An account that hasn't switched R2 on can't make the bucket, so
// that deploy fails: then deploy again with the same config less the R2 block (between "r2-begin" and "r2-end"),
// and Kos keeps attachments on each device until R2 is on.
function deployWorker() {
  const first = wrangler("deploy");
  if (first.ok || !/\br2\b|10042|bucket/i.test(first.output)) return first;
  console.log("deploy: R2 isn't switched on for this account; deploying without attachments (Kos keeps them on each device)");
  const conf = readFileSync("wrangler.jsonc", "utf8");
  const without = conf.replace(/\/\/ r2-begin[\s\S]*?\/\/ r2-end\n?/, "");
  if (without === conf) return first;
  writeFileSync("wrangler.no-r2.jsonc", without);
  try { return wrangler("deploy", "--config", "wrangler.no-r2.jsonc"); } finally { rmSync("wrangler.no-r2.jsonc", { force: true }); }
}
console.log("deploy: applying D1 migrations");
const migrate = wrangler("d1", "migrations", "apply", "DB", "--remote");
if (migrate.ok) {
  console.log("deploy: deploying the Worker");
  must(deployWorker(), "wrangler deploy");
} else if (/provision|couldn't find|could not find|not found/i.test(migrate.output)) {
  console.log("deploy: no database yet (first deploy) — deploying to create it, then migrating");
  must(deployWorker(), "wrangler deploy");
  must(wrangler("d1", "migrations", "apply", "DB", "--remote"), "applying D1 migrations");
} else {
  must(migrate, "applying D1 migrations");
}
console.log("deploy: done");
