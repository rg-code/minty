# Set up Minty for your household

Minty puts your household's bank and card transactions on one private dashboard. You run your
**own copy**, on your own free accounts. Nobody else, including whoever shared this repo, can
see your data or your keys.

It takes about 30–45 minutes, and most of that is Plaid's sign-up. You don't need a server,
Docker, or a terminal: everything below is done in a web browser.

**What it costs:** $0. It uses the free plans of GitHub, Cloudflare (Workers, D1, Access) and
Plaid (Trial). Plaid's Trial covers **10 bank logins per Plaid account**.

You'll need:

- A GitHub account
- A Cloudflare account (free): https://dash.cloudflare.com/sign-up
- A Plaid account (free Trial, US/Canada banks): https://dashboard.plaid.com/signup
  Plaid asks you to verify your identity; approval is usually quick.

---

## 1. Copy the code (fork)

1. Open https://github.com/rg-code/minty and click **Fork** → **Create fork**.
   Keep the name `minty`.

Use a fork, not a download: it's how you get updates later (step 8).

## 2. Deploy it to Cloudflare

1. In the Cloudflare dashboard: **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub and pick your fork `minty`.
3. Settings:
   - **Project name:** `minty` (it must match, or the build fails)
   - **Build command:** leave empty
   - **Deploy command:** replace the default `npx wrangler deploy` with `npm run deploy`. Note it's
     **npm**, not npx: `npx run deploy` fails.
   - **Non-production branch deploy command** (`npx wrangler preview`): leave it as it is.
   - There's no production-branch option on this screen. It uses your repo's default branch
     (`main`); you can check it later under **Settings → Builds → Branch control**.
4. Click **Deploy**. The first deploy creates the database (`minty`) and sets it up. That takes a
   minute or two, and the log ends with "Success! Build completed."
5. Open the Worker's `…workers.dev` address. You should see the dashboard page, with no data yet.
6. Optional tidy-up: in the Worker's **Domains** tab, keep **Production** on and switch the
   **Preview** URL off. Minty doesn't use preview addresses.

Until step 3 is done, the page loads but every data request is refused. That's deliberate: Minty
refuses everything until the login is set up.

## 3. Lock it to your household (Cloudflare Access)

1. Open **Workers & Pages → minty → Access** (a tab along the top of the Worker) and enable
   Access for **All traffic**. (If asked, set up Zero Trust on the free plan. It's free for up
   to 50 people.)
2. **Authentication policy:** pick who may sign in. The list offers pre-configured policies:
   - **Cloudflare Account**: members of your Cloudflare account (you). Always safe.
   - **An email domain**: *anyone* with an address at that domain. Only choose it if the domain
     is yours and you're the only one reading its mail. (A catch-all is fine: codes for any
     address there land in your inbox.)
   - **Never** choose "Everyone" or a public domain like gmail.com.

   To allow a specific outside address (e.g. a partner's Gmail), add a custom policy later:
   **Zero Trust → Access → Policies → Add → Include → Emails**, then attach it to the minty app.
3. Copy the **AUD tag** (a long hex string) that the Access tab shows. Then find your **team
   domain**: open your Minty address in a private window. The sign-in page's address starts
   with `https://<team>.cloudflareaccess.com`, and that host is the team domain.
4. **Settings → Variables and secrets** (the runtime section, *not* the build variables under
   Builds) → **Add**. Environment **Production**. For each row, put the name in **Key** and
   the value in **Value**, leave **Secret unchecked**, and use **+ Add** for the next row:
   - `ACCESS_TEAM_DOMAIN` = the team domain, e.g. `yourteam.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag
   - `ALLOWED_LOGINS` = the exact email address(es) you'll sign in with, comma-separated. It's
     optional but recommended: Minty itself refuses anyone else, even if an Access policy is
     broader than you meant. Each address must also pass the Access policy.

   Then **Deploy**.

Open your Minty address in a private window. You'll be asked for your email and sent a one-time
code, and then the dashboard loads.

## 4. Create the encryption key

Minty encrypts each bank connection's Plaid access token before storing it. In the same
**Variables and secrets** screen, add a variable named `TOKEN_ENC_KEY` with **Secret checked**.

**Moving from the Docker/Python version of Minty?** Use the `TOKEN_ENC_KEY` from that
install's `.env`, not a new one. Your existing bank connections were encrypted with it, and
they can only move over without re-linking if the key is the same. (Re-linking uses up Plaid
Trial slots for good.)

Otherwise, make a new key with one of these:

- macOS / Linux / Git Bash: `openssl rand -base64 32 | tr '+/' '-_'`
- Python: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`

**Keep a copy somewhere safe**, such as a password manager. Without it, stored bank connections
can't be used and you'd have to link them again.

## 5. Get Plaid keys

1. In the Plaid dashboard: **Developers → Keys**. Copy the **client_id** and the **Production**
   secret. (The Sandbox secret works for testing with Plaid's fake banks.)
2. In **Variables and secrets**, add these, each with **Secret checked**:
   - `PLAID_CLIENT_ID_ME_PRIMARY` = client_id
   - `PLAID_SECRET_ME_PRIMARY` = secret
3. Your partner signs up for their own Plaid account and adds `PLAID_CLIENT_ID_SPOUSE_PRIMARY`
   and `PLAID_SECRET_SPOUSE_PRIMARY` the same way. (Separate accounts, because each Plaid Trial
   allows 10 bank logins.)
4. When you're using the Production secret, add a **Text** variable `PLAID_ENV` = `production`.
   Without it, Minty uses Plaid's Sandbox (test banks).

**Other names or more people:** open **+ Add user** on the dashboard. It generates the exact
`MINTY_USERS` value and secret names to add. People default to "Me" and "Spouse".

## 6. Check the setup

Open **+ Add user** on your dashboard. The **Setup checks** list shows what's working and what's
still missing, with the fix for each item. Every line should show ✓, apart from optional
extras such as backup keys.

## 7. Connect your banks

Open **+ Add account**, choose whose account it is, and click **Connect with Plaid**. You sign in
to your bank inside Plaid's window; Minty never sees your bank password.

The first transactions arrive within a minute. On the free plan, the full history (up to 24
months) then fills in about a hundred transactions per hourly sync, so a busy account can
take a day or so. After that, each hourly sync is small. (On Workers Paid, $5/month, set the
variables `SYNC_MAX_BYTES_PER_RUN` = `20000000` and `SYNC_MAX_PAGES_PER_RUN` = `50`, and the
history arrives in an hour or two.) If a bank later needs you to sign in again, **+ Add account**
shows it with a **Reconnect** button.

## 8. Get updates

When Minty gets improvements, open your fork on GitHub and click **Sync fork → Update branch**.
Cloudflare redeploys automatically. Any database changes are applied as part of that deploy,
and your settings, secrets and data are untouched.

---

## Good to know

- **Privacy.** Your data lives only in your Cloudflare account's D1 database. Plaid keys and the
  encryption key are Cloudflare secrets: you can't read them back after saving, and they're
  never sent to the browser.
- **Never set `MINTY_DEV_NO_AUTH`.** It's a local development switch; Minty ignores it on a real
  address, but there's no reason to have it.
- **Sync** runs every hour (at :17 UTC). There's no "sync now" button, by design.
- **Backups.** D1 keeps a point-in-time history (Time Travel) you can restore from:
  https://developers.cloudflare.com/d1/reference/time-travel/
- **Optional settings** (Text variables):
  - `ALLOWED_LOGINS`: extra allow-list of emails, on top of the Access policy.
  - `PLAID_REDIRECT_URI`: only needed for some banks when using Minty inside a phone app's
    built-in browser.
  - `TRIAL_ITEM_CAP`: defaults to 10.
  - `SYNC_MAX_BYTES_PER_RUN` / `SYNC_MAX_PAGES_PER_RUN`: how much each hourly sync does. The
    defaults (150000 / 10) fit the free plan's 10 ms CPU limit. On Workers Paid, raise them.
- **Something's wrong?** Check **+ Add user → Setup checks** first. Then look at
  **Workers & Pages → minty → Logs**, which show sync results by item number and never your
  data.

### Using a terminal instead (optional)

From a clone of your fork, you can do the same with Wrangler:
`npx wrangler login`, then `npx wrangler secret put TOKEN_ENC_KEY` (and each Plaid secret), and
`npm run deploy`. Variables are easiest to set in the dashboard. `keep_vars` in `wrangler.jsonc`
makes sure deploys never overwrite them.
