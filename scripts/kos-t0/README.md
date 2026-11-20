# Kos, T0: the checks before building (docs/trips.md §11)

Six checks, each a few minutes. **You run them** (they use your keys, your Immich and your own
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
5. **For K2** (docs/trips.md §25), once Immich has an address Cloudflare can reach (check 6 below:
   a Cloudflare Tunnel's hostname, behind Access with the service token), run it once more against
   **that** address, with `--k2` instead of `--album-test` (the key needs `asset.view` too):
   ```
   IMMICH_URL=https://<the tunnel's hostname> IMMICH_API_KEY=... IMMICH_ACCESS_CLIENT_ID=... IMMICH_ACCESS_CLIENT_SECRET=... \
   node scripts/kos-t0/immich.ts 2026-06-10 2026-06-17 --k2
   ```
   It adds three lines: how many photos carry their local time, that a thumbnail comes back as an
   image, and what Immich says for an album that isn't there. It makes and deletes nothing.

## 5. Live flight status (AeroAPI)

1. Sign up for **FlightAware AeroAPI, Personal** (no monthly minimum, about $5 of free use a month)
   and make an API key.
2. In your terminal, a flight flying today or tomorrow:
   `AEROAPI_KEY=... node scripts/kos-t0/flight.ts UA837`
3. Paste the output, and AeroAPI's usage page figure for that one call.
4. Optional: the backup, with an AirLabs free key: `AIRLABS_KEY=... node scripts/kos-t0/flight.ts UA837`.

When all five are back, Claude records the results in docs/trips.md and T1 starts.

## 6. Immich through a Cloudflare Tunnel (for K2)

Minty's Worker runs on Cloudflare, so it can't reach an Immich on a tailnet or a home network. A
Cloudflare Tunnel gives Immich's API a hostname that only Minty can use: Cloudflare Access lets
nothing through without a service token, browsers included. You keep opening Immich in the browser
as you do now. Free on the Zero Trust free plan; the hostname must be on a domain you have on
Cloudflare. **Do 1 and 2 before 3**, so the hostname is never open, even for a minute. Keep the tunnel
token, the service token and the API key to yourself: paste back only the outputs in 7.

1. **A service token** (Zero Trust → Access → Service credentials → Service Tokens): **Create Service
   Token**, named `minty-immich`, non-expiring (or a year, with a reminder). Copy the **Client ID** and
   **Client Secret** into your password manager: the secret is shown once.
2. **An Access application for the hostname, before it exists** (Access → Applications → Add an
   application → Self-hosted): name `Immich API`, domain `immich-api.<your domain>`, path blank. One
   policy: name `Minty only`, **Action: Service Auth** (not Allow), Include → **Service Token** →
   `minty-immich`. No other policies. Use the same Zero Trust organization as Minty's Access.
3. **The tunnel** (Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared): name it `immich`,
   pick the Immich machine's environment, and run the install command Cloudflare shows (it holds the
   tunnel's token) on that machine.
   - **If Immich runs in Docker Compose,** you can add cloudflared to Immich's `docker-compose.yml`
     instead, with `CLOUDFLARE_TUNNEL_TOKEN=<the token>` in Immich's `.env`, then `docker compose up -d`:
     ```yaml
       cloudflared:
         container_name: immich_cloudflared
         image: cloudflare/cloudflared:latest
         command: tunnel --no-autoupdate run
         environment:
           - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
         restart: always
     ```
   - When it shows **Healthy**, add a **Public hostname** ("Published application routes" in newer
     dashboards): subdomain `immich-api`, your domain, path blank, service **HTTP**, URL
     `localhost:2283` (cloudflared on the machine itself) or `immich-server:2283` (in Immich's Compose
     file: that's Immich's service name there).
4. **Check it's closed** (your terminal):
   ```
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://immich-api.<your domain>/api/server/version
   ```
   Expect a **302 to `….cloudflareaccess.com`, or 403**. If you get Immich's version instead, Access isn't
   guarding the hostname: stop and check 2.
5. **Check the token gets through** (`read -s` keeps the secret out of your shell history):
   ```
   read -p "Client ID: " CFID; read -s -p "Client Secret: " CFSECRET; echo
   curl -s -H "CF-Access-Client-Id: $CFID" -H "CF-Access-Client-Secret: $CFSECRET" https://immich-api.<your domain>/api/server/version
   ```
   Expect Immich's version: `{"major":…,"minor":…,"patch":…}`. If not:
   - a page from `cloudflareaccess.com`: the policy isn't **Service Auth**, or the token is wrong;
   - a Cloudflare challenge page: Bot Fight Mode is on for the domain; add a WAF skip rule for the hostname;
   - 502 or error 1033: the tunnel can't reach Immich; check the service URL in 3.
6. **The Immich key** (Account Settings → API Keys): edit the "Minty" key to add **`asset.view`**
   (the journal's thumbnails). Then run check 4's script through the tunnel with `--k2` (any past trip's
   dates; it makes and deletes nothing):
   ```
   IMMICH_URL=https://immich-api.<your domain> IMMICH_API_KEY=<the Minty key> \
   IMMICH_ACCESS_CLIENT_ID=$CFID IMMICH_ACCESS_CLIENT_SECRET=$CFSECRET \
   node scripts/kos-t0/immich.ts 2026-06-10 2026-06-17 --k2
   ```
7. **Paste back:** the line from 4, the version from 5, and the whole output of 6. None of them holds a
   key.
8. **Then Minty's Worker settings** (Workers & Pages → minty → Settings → Variables and secrets):
   variables `IMMICH_URL` = `https://immich-api.<your domain>` and `IMMICH_LINK_URL` = where you open
   Immich in a browser (its tailnet address), for the album links; secrets `IMMICH_API_KEY`,
   `IMMICH_ACCESS_CLIENT_ID`, `IMMICH_ACCESS_CLIENT_SECRET`. Within about 10 minutes, Setup says whether
   the key works and has what Kos needs.

