// Kos T0 (docs/trips.md §2.1): does Cloudflare Access let a service token through to Minty? Run it in
// YOUR terminal, after making the token and its Service Auth policy on Minty's Access application:
//
//   MINTY_URL=https://minty.example.workers.dev ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... \
//   node scripts/kos-t0/access.ts
//
// It asks for /healthz (the one path the Worker answers without a person's login) with the token,
// and says whether Access passed it on or sent it to the sign-in page. No keys are printed.
const { MINTY_URL, ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET } = process.env;
if (!MINTY_URL || !ACCESS_CLIENT_ID || !ACCESS_CLIENT_SECRET) { console.error("set MINTY_URL, ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET"); process.exit(1); }
const ask = (h: Record<string, string>) => fetch(`${MINTY_URL.replace(/\/+$/, "")}/healthz`, { headers: h, redirect: "manual" });
const without = await ask({});
const withToken = await ask({ "CF-Access-Client-Id": ACCESS_CLIENT_ID, "CF-Access-Client-Secret": ACCESS_CLIENT_SECRET });
const say = (r: Response, body: string) => r.status >= 300 && r.status < 400 ? `redirected to the sign-in page (${new URL(r.headers.get("location") ?? "", MINTY_URL).host})`
  : `HTTP ${r.status}${body.includes('"ok":true') ? ", Minty answered" : ""}`;
console.log(`without the token: ${say(without, await without.text())}`);
const body = await withToken.text();
console.log(`with the token:    ${say(withToken, body)}`);
console.log(withToken.status === 200 && body.includes('"ok":true') ? "OK: Access lets the token through." : "Not through: check the Service Auth policy on Minty's Access application.");
