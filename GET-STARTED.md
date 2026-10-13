# Get started with Minty

Your own private dashboard of all your bank and card transactions. It runs on your own free
accounts, so only you can see it. **About 30 minutes, all in a web browser, $0.**

More detail on any step: [SETUP.md](SETUP.md).

## 1. Make three free accounts

| Account | Sign up | Why |
|---|---|---|
| GitHub | https://github.com/signup | Holds your copy of Minty's code |
| Cloudflare | https://dash.cloudflare.com/sign-up | Runs Minty and stores your data |
| Plaid | https://dashboard.plaid.com/signup | Connects to your banks (US/Canada). It checks your identity, usually quickly |

## 2. Copy Minty

1. Signed in to GitHub, open https://github.com/rg-code/minty/fork and click **Create fork**.
2. In your new fork, open the **Actions** tab and click **I understand my workflows, go ahead and
   enable them**. This lets your copy update itself every week (step 7).

## 3. Put it on Cloudflare

1. Open https://dash.cloudflare.com and go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and pick **minty**.
3. Set **Deploy command** to `npm run deploy`. Leave everything else as it is.
4. Click **Deploy**, and wait for "Success" (a minute or two).

## 4. Lock it to you

1. Open **Workers & Pages → minty → Access**, turn Access on for **All traffic**, and choose the
   **Cloudflare Account** policy.
2. Copy the **AUD tag** it shows. Then open your Minty address (`…workers.dev`) in a private
   window: the sign-in page's address starts with `https://<team>.cloudflareaccess.com`. That
   host is your team domain.
3. Open **minty → Settings → Variables and secrets → Add** and add these three:

   | Name | Value | Type |
   |---|---|---|
   | `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | Text |
   | `ACCESS_AUD` | the AUD tag | Text |
   | `ALLOWED_LOGINS` | your email address | Text |

## 5. Add your keys

1. **Encryption key.** Make one on your computer, then save a copy in your password manager:
   - Mac: open Terminal and run `openssl rand -base64 32 | tr '+/' '-_'`
   - Windows: open PowerShell and run
     `$b=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);[Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')`
2. **Plaid keys:** open https://dashboard.plaid.com/developers/keys and copy the **client_id**
   and the **Production** secret.
3. Add them in **Variables and secrets**, then click **Deploy**:

   | Name | Value | Type |
   |---|---|---|
   | `TOKEN_ENC_KEY` | the encryption key | Secret |
   | `PLAID_CLIENT_ID_ME_PRIMARY` | Plaid client_id | Secret |
   | `PLAID_SECRET_ME_PRIMARY` | Plaid Production secret | Secret |
   | `PLAID_ENV` | `production` | Text |

## 6. Connect your banks

1. Open your Minty address and sign in with your email (you'll get a one-time code).
2. Click **+ Add user**: every line under **Setup checks** should show ✓. Each one that doesn't
   says how to fix it.
3. Click **+ Add account → Connect with Plaid**, and sign in to your bank in Plaid's window.
   Transactions start arriving within a minute.

## 7. Keep it up to date (required)

Your copy updates itself **every Monday**: the *Stay up to date* workflow you enabled in step 2
pulls the latest Minty, and Cloudflare redeploys it. Your data and settings stay.

- **Want it now?** On your fork: **Actions → Stay up to date → Run workflow**.
- **Got an email that it failed?** Open your fork and click **Sync fork → Update branch**. That's
  all it takes; it happens when an update changes one of GitHub's workflow files.
- **Skipped step 2?** Then nothing updates by itself. Enable it now, or click **Sync fork →
  Update branch** at least once a month.

## Later

- **Your name, or more people:** **+ Add user**.
- **Stuck?** Check **+ Add user → Setup checks**, then [SETUP.md](SETUP.md).
- **License:** use Minty unmodified, for personal or household use only: no changes, no
  redistribution, no commercial use. See [LICENSE](LICENSE).
