# Kos, T0: the checks before building (docs/trips.md §11)

Five checks, each a few minutes. **You run them** (they use your keys, your Immich and your own
emails), and paste their output back to Claude. They print results only: never a key, never an
email's content, never a photo's location. **Keys go in your terminal's environment or the Apps
Script editor, never in a file in this repo.** Run the Node ones in your own terminal, not through
Claude (a `!` command would put the keys in the conversation).

## 1. Your booking emails (no keys)

1. In Gmail, open ~20 travel confirmations of different kinds (flights, hotels, a car, a restaurant,
   an event), and for each: ⋮ → **Download message**. Put the `.eml` files in a folder **outside
   this repo**, e.g. `~/kos-emails`.
2. `node scripts/kos-t0/parse.ts ~/kos-emails`
3. Paste the **summary** lines. They tell us how many senders use schema.org markup (the exact,
   easy path), which fields they leave out, and whether reading fits the Worker's 10 ms.
4. Delete the folder afterwards if you like; nothing was copied.

## 2. Cloudflare Access with a service token (for the Gmail script)

1. Cloudflare dashboard → **Zero Trust → Access → Service credentials → Service tokens → Create**,
   named "minty-inbox". Copy the Client ID and Client Secret now (the secret is shown once).
2. **Access → Applications → Minty → Policies → Add a policy:** action **Service Auth**, include
   **Service Token: minty-inbox**. Save.
3. In your terminal:
   `MINTY_URL=https://<your minty> ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... node scripts/kos-t0/access.ts`
4. Paste the three lines. "OK" means Access lets the token through, and Minty never sees a sign-in.

## 3. The Gmail script, from Google's side

1. Make the Gmail account for Minty (e.g. `ourminty@gmail.com`) if you haven't, and its two labels
   `Minty/Trips` and `Minty/Bills`.
2. Signed in as that account, open **script.google.com → New project**.
   - Paste `apps-script/Code.gs` over the editor's file.
   - Project Settings → show `appsscript.json` → paste `apps-script/appsscript.json`.
   - In the editor only, fill in `MINTY_URL` and the token's Client ID and secret.
3. **Run → spike.** Allow it: "Google hasn't verified this app" → Advanced → Go to the project. It
   asks only to read Gmail and to call a web address.
4. **View → Logs**: paste the lines. Then delete the project (or just the two values) until T2.

## 4. Immich (your key)

1. In Immich: **Account Settings → API Keys → New API Key**, named "Minty", with `asset.read`,
   `album.read`, `album.create`, `albumAsset.create` (add `user.read` just for this check, so it
   can tell your photos from a partner's).
2. A service token for **Immich's** Access application: as in check 2, but named "minty-immich",
   with its Service Auth policy on the **Immich** application.
3. In your terminal, with a past trip's first and last day:
   ```
   IMMICH_URL=https://<your immich> IMMICH_API_KEY=... IMMICH_ACCESS_CLIENT_ID=... IMMICH_ACCESS_CLIENT_SECRET=... \
   node scripts/kos-t0/immich.ts 2026-06-10 2026-06-17 --album-test
   ```
4. Paste the output. It shows the version, the key's permissions (and any missing), how many photos
   those days have with GPS and a city, whether a partner's are included, and whether making an
   album works. The key can't delete albums, so delete "Minty T0 test" in Immich afterwards (the
   photo stays).

## 5. Live flight status (AeroAPI)

1. Sign up for **FlightAware AeroAPI, Personal** (no monthly minimum, about $5 of free use a month)
   and make an API key.
2. In your terminal, a flight flying today or tomorrow:
   `AEROAPI_KEY=... node scripts/kos-t0/flight.ts UA837`
3. Paste the output, and AeroAPI's usage page figure for that one call.
4. Optional: the backup, with an AirLabs free key: `AIRLABS_KEY=... node scripts/kos-t0/flight.ts UA837`.

When all five are back, Claude records the results in docs/trips.md and T1 starts.
