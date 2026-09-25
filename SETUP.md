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
   - **Deploy command:** `npm run deploy`
4. Click **Deploy**. The first deploy creates the database (`minty`) and sets it up. That takes a
   minute or two.
5. Open the Worker's `…workers.dev` address. You should see the dashboard page, with no data yet.

Until step 3 is done, the page loads but every data request is refused. That's deliberate: Minty
refuses everything until the login is set up.

## 3. Lock it to your household (Cloudflare Access)

1. **Workers & Pages → minty → Settings → Domains & Routes**. Next to the `workers.dev` route,
   choose **Enable Cloudflare Access**. (If asked, set up Zero Trust on the free plan. It's free
   for up to 50 people.)
2. The confirmation shows two values. Copy both:
   - the **team domain**, like `yourteam.cloudflareaccess.com`
   - the **Application Audience (AUD) tag**, a long hex string

   To find them later: **Zero Trust → Access → Applications → minty**. The AUD tag is under
   **Additional settings**.
3. In that Access application, edit the policy so only your household can sign in: **Include →
   Emails** → your and your partner's email addresses.
4. Back in **Workers & Pages → minty → Settings → Variables and secrets**, add two **Text**
   variables:
   - `ACCESS_TEAM_DOMAIN` = the team domain
   - `ACCESS_AUD` = the AUD tag

Reload your Minty address. You'll be asked for your email and sent a one-time code, and then
the dashboard loads.

## 4. Create the encryption key

Minty encrypts each bank connection's Plaid access token before storing it. In the same
**Variables and secrets** screen, add a **Secret** named `TOKEN_ENC_KEY`. Make its value with one
of these:

- macOS / Linux / Git Bash: `openssl rand -base64 32 | tr '+/' '-_'`
- Python: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`

**Keep a copy somewhere safe**, such as a password manager. Without it, stored bank connections
can't be used and you'd have to link them again.

## 5. Get Plaid keys

1. In the Plaid dashboard: **Developers → Keys**. Copy the **client_id** and the **Production**
   secret. (The Sandbox secret works for testing with Plaid's fake banks.)
2. In **Variables and secrets**, add these **Secrets**:
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

The first transactions arrive within a minute. The full history (up to 24 months) fills in over
the next hourly syncs. If a bank later needs you to sign in again, **+ Add account** shows it
with a **Reconnect** button.

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
  - `SYNC_MAX_PAGES_PER_RUN`: defaults to 10. Raise it if you're on Workers Paid.
- **Something's wrong?** Check **+ Add user → Setup checks** first. Then look at
  **Workers & Pages → minty → Logs**, which show sync results by item number and never your
  data.

### Using a terminal instead (optional)

From a clone of your fork, you can do the same with Wrangler:
`npx wrangler login`, then `npx wrangler secret put TOKEN_ENC_KEY` (and each Plaid secret), and
`npm run deploy`. Variables are easiest to set in the dashboard. `keep_vars` in `wrangler.jsonc`
makes sure deploys never overwrite them.
