# Plan: Kos, trips (a Flighty and Wanderlog hybrid)

**Status: J1 built (2026-11-19): the Kos app at `/kos/` (§16), with T1, T3, T6a and T6b, and Kos on its own (§17). T0 started: the owner runs `scripts/kos-t0/`; T2, T5, T6c and T7 follow its results.** Its
inbox (§2) also serves Bills. Named **JET** (owner, 2026-11-19), renamed **Kos** (owner, 2026-11-20; §19).

A trip view built from the household's bookings:
- a day-by-day itinerary (like Wanderlog);
- flight cards (like Flighty);
- the trip's transactions, with a filter to just those;
- the points and miles it spent or earned, in BAM;
- a link to an Immich album of the photos taken during it.

Bookings come in **without Minty reading anyone's mailbox** (§2).

## 1. What it shows

- **Trips:** a name, dates and places, made from the bookings. Minty suggests a trip when
  bookings cluster in time; the owner names it, merges or splits.
- **Itinerary, by day,** in each place's own time zone: flights, hotels (check-in and check-out),
  car hire, trains, restaurant reservations, activities and events, each with its confirmation
  number, address and cost.
- **Flight cards:**
  - airline and flight number, the airports, departure and arrival in local time, duration;
  - terminal, gate and seat when the booking gives them;
  - the confirmation code, a countdown, and "add to calendar" (an `.ics` made in the browser).
  - Live status (delays, gate changes) is an optional later phase (§11, T6): it needs a paid
    flight-data service.
- **The trip's transactions** (§6): suggested, confirmed by the owner, then totals by category and
  "Open in dashboard" with the filter set, so Select and its Summary work there.
- **Points** (§7): miles spent on award bookings, shown in BAM against the program's balance.
- **Photos** (§8): an Immich album of the trip's dates, with its link.
- **The timeline** (§15): where the household was each day and when, on the map, from the bookings,
  the photos' metadata and the transactions.

## 2. Getting bookings in (decided by the owner, 2026-11-19)

**No mailbox is connected to Minty, and there are no sender lists.** A booking reaches Minty only
because someone in the household chose to send it. There are two ways in by email, and one without.

### 2.1 Gmail: the default for every household

**Recommended: a Gmail account made only for Minty** (owner's decision, 2026-11-19), e.g.
`ourminty@gmail.com`. Google's read-only Gmail permission covers a whole mailbox, with nothing
narrower such as one label. In an account that only ever receives what the household forwards, the
script can only ever see that. The household's own mailboxes grant nothing. (The household's own
Gmail also works, for those who'd rather not make an account, with the label as the boundary.)

**One mailbox for several views.** Gmail delivers `name+anything@gmail.com` to `name@gmail.com`, so
each Minty view gets its own address. Minty sends each message to the view its address names:

| Forward to | Label | Goes to |
|---|---|---|
| `ourminty+mintytrips@gmail.com` | `Minty/Trips` | Trips |
| `ourminty+mintybills@gmail.com` | `Minty/Bills` | Bills (§2.3) |

A **Google Apps Script** in that account sends Minty the mail that has one of those labels. Mail
gets a label in two ways only:

1. **Forwarding to the view's address**, from any mailbox: Gmail, a work account, a partner's,
   Outlook. One Gmail filter per view labels it: `to:(ourminty+mintytrips@gmail.com)
   from:(the household's addresses)`, and the same for `+mintybills`. The `from:` part means a
   stranger writing to the address isn't labeled. Minty's Setup page shows the exact text to paste
   into Gmail's "Create filter" box.
2. **Labeling by hand** in Gmail, on a phone or a computer.

Nothing else is ever sent: no automatic labeling by sender (owner's decision). Minty decides the
view from the address the message was sent to (the `+mintytrips` or `+mintybills` in its
`Delivered-To` / `To` headers), and from the label as a fallback. A message for no view waits in the
inbox, unassigned.

**The script** runs in the household's Google account every 10 minutes:
- It finds labeled messages from the last 30 days that it hasn't sent yet. It keeps track of what
  it sent in its own storage, so it never changes the mail.
- It sends each one's raw content to `POST /inbox` on the household's Minty. If a send fails,
  it tries again on the next run; after 3 failures it lists the message instead.
- It asks Google only for read-only Gmail access, permission to call a web address, and a timer.
  It's short enough to read in full.
- Outlook and other mailboxes need nothing of their own: forwarding to the Gmail `+minty` address
  covers them.

**What Minty checks:** only that the request carries the household's access key. The script runs
on Google's servers, which can't sign in to Cloudflare Access the way a person does, so it uses an
Access **service token**:
- Access checks the token before the request reaches Minty.
- The Worker then accepts it on `POST /inbox` only, and only when the token's Client ID (the
  `common_name` in Access's JWT) matches the `INBOX_TOKEN_ID` setting. Every other route still
  needs a person's login.
- **The key gives no access to email,** nor to anything in Minty: it can only drop a message into
  Minty's inbox, where it waits as a suggestion. If it leaked, someone could add fake bookings or
  bills to confirm, and nothing could be read. It's revoked by deleting it in Cloudflare.
- **The Gmail permission stays with Google:** the script holds it, Minty never sees it, and it's
  removed at myaccount.google.com/permissions.
- There's **no sender authentication**: the household chose every message.
- Messages are still untrusted text. They're parsed, never rendered or run, and every booking is a
  suggestion until it's confirmed.
- This changes the security model: **approved by the owner (2026-11-19)**, recorded in
  [security-plan.md](security-plan.md) §6, with its tests and limits.

**Setting it up (once, about 5 minutes):**
1. **Cloudflare:**
   - Zero Trust → Access → Service credentials → create a **service token**.
   - On Minty's Access application, add a **Service Auth** policy for that token.
   - Put its Client ID in the Worker variable `INBOX_TOKEN_ID`.
   - A Setup check confirms the token gets through.
2. **Gmail:** make the account for Minty (recommended), its two labels, and the two filters from
   the text Minty shows.
3. **Minty → Setup → Inbox:** paste the Client ID and secret, then **Copy script**. The page builds
   the script in the browser, so the secret is never saved in Minty.
4. **script.google.com,** signed in as the account for Minty: New project, paste, run **setup**,
   and allow it. Google says it isn't verified, because it's your own script: Advanced → Go to
   project.

SETUP.md walks through it with screenshots.

### 2.2 Forward to Minty: households with a domain on Cloudflare (the owner's case)

Addresses on the household's domain (e.g. `trips@…` and `bills@…`, each naming its view) are routed by Cloudflare Email Service to an
`email()` handler in **Minty's own Worker**, beside `fetch` and `scheduled`. There's nothing new
to deploy, and it's idle until a route points at it. Inbound routing is free on the Workers Free
plan. Cloudflare needs the domain's DNS on Cloudflare (subdomains work) and keeps no inbox.
[Docs](https://developers.cloudflare.com/email-service/), [the handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

You forward what you choose, as with `+minty`. Anyone on the internet can send to an address on
a domain, though, so Minty checks one thing: the message is **from an address in
`ALLOWED_LOGINS`** (the household member who forwarded it), and Cloudflare's own DMARC verdict
on that sender passes. That's one header compared, with no sender lists. Anything else is
dropped silently, with no bounce.

**The owner uses both** 2.1 (`+minty` and by hand, in Gmail) and 2.2.

### 2.3 Bills by email

The same inbox serves Bills (`docs/bills.md`, own bills): forward a biller's email to `+mintybills`
(or `bills@…`).
- **The email's own text** ("Your bill of $84.12 is due Dec 3") is read with `bill-parse.js`,
  which is pure and runs in the Worker as well as in the browser. The result is a bill suggested in
  Bills, waiting for a confirm, like its PDFs today.
- **A PDF attachment: kept until a browser reads it (owner's decision, 2026-11-19, option a).**
  - The attachment waits in the inbox, up to 2 MB (D1's row limit). Bills reads it with pdf.js the
    next time it opens, in the browser as today, and the PDF is deleted from D1 at once. One that's
    never read is deleted after 30 days.
  - Only the fields and SHA-256 are kept, as today.
  - **This is an exception to Bills' rule** that PDFs never leave the device. A forwarded PDF has
    already been through the household's mailbox, and Minty keeps it only until it's read.
    CLAUDE.md's Bills rule gets that exception in the same PR (T2c).
  - Set aside: (b) ignoring attachments.
- Card statements stay with Plaid (Liabilities); this is for the household's own bills.

### 2.4 Without email, for everyone

- **Paste, PDF or screenshot,** reusing SUB's on-device readers (`pdf-read.js`, `/sub-scan`'s
  Tesseract).
- **Share to Minty** on Android: the installed app takes a shared screenshot or PDF (`share_target`
  in the manifest). iOS doesn't support this for web apps; there, it's a screenshot picked in Minty.
- **Wallet passes and calendar files** (`.pkpass`, `.ics`) as a later step.

### 2.5 Considered and set aside

- **Minty reading a mailbox** (Gmail API): a Google Cloud project, the restricted `gmail.readonly`
  scope, refresh tokens that expire every 7 days while the app is in "Testing", and Minty holding a
  credential that reads the whole mailbox.
- **Labeling automatically by sender** (a filter of airlines and hotels): sender lists to keep up to
  date, and each sender's authentication to check. The owner chose household-chosen mail only.
- **Third-party inbound-mail services** (Postmark, CloudMailin, AgentMail): an address with no
  domain, but they'd read every booking, and Minty would need an endpoint reachable without signing
  in.
- **One shared address for every fork:** whoever ran it would receive every household's bookings.
- **Buying a domain just for this:** possible (Cloudflare Registrar, at cost), but not required.

## 3. Reading a booking

1. **Structured data first.** Most airline, hotel and booking-site confirmations carry schema.org
   markup (JSON-LD or microdata) for Gmail's own trip cards: `FlightReservation`,
   `LodgingReservation`, `RentalCarReservation`, `TrainReservation`, `FoodEstablishmentReservation`,
   `EventReservation`. These give exact fields: flight number, airports, times with offsets,
   confirmation number, guest name, price.
2. **Known senders next:** parsers for the shapes of the senders the household uses (tested on
   made-up copies, like `bill-parse.js`).
3. **Text last:** the same kind of parser as `sub-parse.js` for what's left (a screenshot, a PDF).
   It suggests, each field with the words it came from, and the owner confirms.

**Never guessed:** a booking with no time zone keeps "local time" without converting it, and one it
can't read waits in an inbox in the trip view ("2 forwarded emails couldn't be read") with what was
found.

**CPU:** decoding a forwarded email (MIME, quoted-printable, base64) and finding its JSON-LD on
the free plan's 10 ms is the open question. T0 measures it on real confirmations. If it doesn't
fit, `POST /inbox` and the `email()` handler only store the message (capped at 256 KB), and
the cron parses a few per run, as sync handles Plaid's pages.

## 4. What it stores

All of these are written by the household and the ingest only; sync never writes them.

- **`trips`:** name, start and end date, the main place, notes, and the Immich album id once made.
- **`trip_items`**, one per booking (a booking can exist before it belongs to a trip):
  - kind: flight, lodging, car, train, restaurant, activity, other;
  - start and end (local time plus its UTC offset, or local only), place name, address,
    confirmation number;
  - cost and currency, and points spent with their BAM program;
  - source (email, paste, PDF, screenshot, typed), and its SHA-256.
  - **Flights** add airline, flight number, from and to (IATA), terminal, gate, seat and fare
    class, one row per leg.
- **`inbox_messages`** (the inbox, shared by Trips and Bills; each message has its view): forwarded
  messages waiting to be read or confirmed. It keeps the extracted
  fields, plus the message's text for 30 days so a parser fix can read it again, then deletes it
  (owner's decision, 2026-11-19).
- **`trip_transactions`:** links a transaction to a trip, by the owner (confirmed) or suggested
  (§6). Indexed on `(trip_id, transaction_id)`.

## 5. The view

In the ⋯ menu, as a popup like SUB.
- **Upcoming first:** the next trip's countdown and its first flight's card.
- **Each trip:** the itinerary by day, its flights, the transactions panel, points and the album.
- **The person switch** filters by who's travelling: each booking keeps the names on it, mapped
  to `MINTY_USERS` people where they match. It's a filter, as everywhere.
- **Optional later:** a map of the trip's places (map tiles from another host need that host in
  the policy) and live flight status: §13 and §14.

## 6. The trip's transactions

Suggested, never added silently. A suggestion comes from one of these:
- **During the trip:** dated from the day before it starts to the day after it ends, on any
  account. Travel, food, transport and entertainment are suggested at once; other categories are
  listed below as "also during the trip".
- **Bookings made before:** a charge that matches a booking's cost (within a few percent and the
  currency) or its merchant (the airline, hotel or booking site), dated from the booking's email
  back up to a year.
- **Refunds and changes:** a credit from the same merchant after the trip. This reuses
  `reconcile.js`'s pairing (a cancellation fee, or an upgrade then a refund).

The owner confirms each one, or "add all suggested". The trip then shows totals by category and
person, and the cost per day. "Open in dashboard" sets `/?trip=<id>`.
- `GET /transactions` gains a `trip_id` filter through `trip_transactions`, index-driven, with a
  line in `test/reads.test.ts`.
- **Not tags:** a link table rather than a tag, because tags written by Minty automatically are
  still an open decision (agent plan, A3).

## 7. BAM: points and miles

- **Spent:** an award booking's points and program (from the booking, or typed) show in BAM as a
  **pending change**, e.g. "−35,000 United MileagePlus (Tokyo trip)", against the latest reading,
  until a newer reading replaces it. Readings stay readings: nothing is written to `point_balances`.
  **Built (T4, 2026-11-20):** a reading dated on or after the day the booking was added to Kos ends it;
  the balance is the trip's one traveller's, or the only person's, else the household's. Kos names the
  program on the booking ("45,000 Wyndham Rewards points") and its edit page says it's pending in BAM.
  An email's points and program are read by `kos-parse.js` (`programIn`).
- **Earned:** only when the booking says so ("you'll earn 2,140 miles"). Miles earned depend on
  fare and status, so they're never estimated.
- **Transfers** between programs (e.g. card points to an airline) are out of scope for now.

## 8. Immich: an album of the trip

**Access through Immich's API (owner, 2026-11-19).** The owner's Immich is behind Cloudflare Access,
so Minty needs two things, both set up once by the owner.

**1. An Immich API key**, in Immich: Account Settings → API Keys → New API Key, named "Minty".
- **It acts as that Immich user.** Use the account whose library holds the trip photos (usually the
  owner's). Its permissions:

  | Permission | For |
  |---|---|
  | `asset.read` | finding the photos taken during the trip |
  | `album.read` | checking the album Minty made is still there |
  | `album.create` | making the album |
  | `albumAsset.create` | adding photos to it, including ones uploaded later |
  | `asset.view` | the journal's thumbnails, through the Worker (K2, §25) |

  Nothing that deletes, edits, downloads or shares.
- **Version caveat:** before Immich 1.138, a key needed the `all` permission. Since Immich 3.0, routes
  without a permission of their own need `all` too. T0 checks the household's version: Minty reads
  the key's own permissions (`GET /api/api-keys/me`, which needs none) and Setup shows any that are
  missing. If the version needs `all`, the household decides whether to give it.
- Stored as the Worker secret `IMMICH_API_KEY`. The address (`IMMICH_URL`) is a variable.

**2. A Cloudflare Access service token for Immich's own Access application:**
- Zero Trust → Access → Service credentials → create "minty-immich".
- On **Immich's** Access application (not Minty's), add a **Service Auth** policy for it.
- Stored as `IMMICH_ACCESS_CLIENT_ID` and `IMMICH_ACCESS_CLIENT_SECRET` (secrets), sent as Access's
  service-token headers with each call.
- This is a different token from the Gmail script's (§2.1): that one only gets into Minty, this
  one only gets into Immich.

None of these is ever returned to a page. **Setup checks:** the key works, its permissions, and the
token gets through.

**Whose photos.** An album belongs to the key's user, and the search covers that user's library.
- With Immich's **partner sharing**, the partner's photos may show in that user's timeline. Whether
  the search includes them, and whether a partner's photo can go into the album, is checked in T0.
- If not, a second key per person (`IMMICH_API_KEY_<PERSON>`) gives each person their own album of
  the trip. ✋ Only if T0 shows it's needed.

**When:** from the cron, never on a request (as built in K2, §25: quiet catch-up runs, one trip each).
- The first run after a trip ends makes the album.
- It's checked once a day for 7 days after, for photos uploaded late.
- **Make the album now** on a trip only records a request, like tapping the logo; the next run does
  it.

**What it does:**
1. **Search** the photos and videos taken from the trip's first day at 00:00 to its last day at
   23:59, in the trip's time zone (and each flight day in the departure city's zone), using Immich's
   metadata search, paged (T0 confirms its date parameters).
2. **Make an album** named after the trip ("Tokyo, Mar 2027") with them. Later checks add only new
   ones.
3. **Keep the album id** on the trip.

**What it never does:** delete or edit a photo, remove one from the album, make a public shared
link, or download anything into Minty. If the household deletes the album in Immich, Minty notices
and doesn't make it again; the trip offers **Make it again**.

**The trip shows "Photos: 214 in Immich ↗"**, a link to the album, which opens in Immich behind its
own Access sign-in.
- ~~There are no thumbnails in Minty~~ K2 (§25) shows a few of each day's photos, through the Worker.

**Budget:** a search page holds up to 250 assets. A run makes the search pages plus one album call,
well inside the 50 subrequests, and a big trip spreads over several runs.

## 9. Security and privacy

- **What gets in:** only mail the household chose (§2): labeled in Gmail and sent with the
  household's access key, or forwarded from an allowed login to the domain's address. Minty never
  replies, never follows a link in a message, and never loads remote images.
- **Forwarded mail is untrusted text.** It's parsed, never executed. HTML is never rendered: the
  trip view shows extracted fields, and the stored text is shown as plain text.
- **What's kept:** extracted fields, a SHA-256 per message, and the text for 30 days (§4).
- **Secrets:** Immich's and Access's are Worker secrets. No new browser hosts, except a map's tiles
  if T6 adds one.
- **Trust model unchanged:** every allowed login sees every trip.

## 10. Limits

- **CPU (10 ms):** parsing as a message arrives or, if it doesn't fit, in the cron with a budget
  (§3, T0).
- **D1 reads:** the trip view reads its trips, items and links by index. Suggestions read the
  trip's date window by the date index, bounded at both ends. Each route gets a budget in
  `test/reads.test.ts`.
- **Immich:** cron-only, paged, and inside the subrequest limit.

## 11. Phases (each ends with a PR the owner reviews)

| Phase | What | ✋ |
|---|---|---|
| **T0 Spikes** (started 2026-11-19) | The owner runs `scripts/kos-t0/` (its README): their own ~20 confirmations through `src/kos/mime.ts` and `reservations.ts` (tested, the T2 reader); Access with a service token, from a terminal and from an Apps Script with read-only Gmail; Immich's version, key permissions, metadata search (GPS, city, a partner's photos) and an album; AeroAPI (and AirLabs) for one flight. Email Routing on the owner's domain waits for T2b | Service tokens, Immich key, AeroAPI key, test emails |
| **T1 Trips and bookings** | `trips`, `trip_items`; typed, pasted, PDF and screenshot input; the itinerary and flight cards | Name |
| **T2 Gmail (default)** | The inbox (`inbox_messages`, shared by views), `POST /inbox` for the household's Access service token, the Apps Script and its Setup page (Copy script, the filter text for `+mintytrips` and `+mintybills`), JSON-LD and known-sender parsers, SETUP.md's steps (a Gmail account for Minty), the security-plan entry | Approve the security change |
| **T2c Bills by email** | `+mintybills` messages read with `bill-parse.js` into suggested bills; PDF attachments kept until Bills reads them, then deleted (§2.3, option a); CLAUDE.md's Bills rule gets the exception | |
| **T2b Forward to Minty** | The `email()` handler in Minty's Worker for a domain on Cloudflare, the allowed-login check, a Setup check | The owner's forwarding address |
| **T3 Transactions** | Suggestions, confirm, totals, `/?trip=` in the dashboard | |
| **T4 BAM** | Pending changes from award bookings (built 2026-11-20: docs/bam.md §3) | |
| **T5 Immich** | Albums from the cron, the link on the trip | Secrets |
| **T6a Map** | Minty's own SVG map: the world outline, airports, flight arcs and places with coordinates; "Open in Maps" links (§13) | |
| **T6b Street map** | MapLibre (vendored) with OpenFreeMap's tiles, the trip page's policy gaining its host (§13, option 2) | |
| **T6c Live flight status** | AeroAPI (and AirLabs) adapters, cron-only polling with a daily cap, on the flight cards and the status strip (§14) | AeroAPI key |
| **T7 Timeline** | The trip's day-by-day timeline and its map from bookings, Immich's photo metadata and the transactions (§15) | |

## 12. Decisions for the owner

1. **The name: Kos** (decided 2026-11-19).
2. **How bookings come in: decided (2026-11-19).** The Gmail script by default, with mail labeled
   only by `+minty` forwarding or by hand; forwarding to the domain's address where there's a domain
   on Cloudflare (the owner has both); paste, PDF, screenshot and share for everyone (§2).
3. **Keep a forwarded message's text 30 days** for re-reading (decided 2026-11-19).
4. **Immich: through its API (decided 2026-11-19),** with an API key with four permissions and a
   service token for Immich's Access application (§8). **The owner's key** (decided 2026-11-19); a
   second person's key only if T0 shows partner sharing doesn't cover their photos.
5. **Map and live flight status: build both (decided 2026-11-19),** after T1 (they draw on trips).
   Live status uses FlightAware AeroAPI Personal (§14). The street map (T6b) uses **OpenFreeMap's
   tiles** (decided 2026-11-19).
6. **For forks too:** the Gmail script works for any household with a Gmail account, forwarding to
   Minty for those with a domain on Cloudflare, and paste, PDF and screenshot always.
7. **The Gmail script's security change: approved (2026-11-19).** One route, `POST /inbox`, accepts
   the household's Access service token instead of a person's login (§2.1, security-plan §6).
8. **A Gmail account made for Minty: recommended (decided 2026-11-19),** shared by Trips
   (`+mintytrips`) and Bills (`+mintybills`).
9. **Bills' PDF attachments: kept until a browser reads them (decided 2026-11-19, option a, §2.3).**

## 13. The map (T6a, T6b)

A Wanderlog-style map of the trip: its places, and its flights as arcs.

**Option 1, first (T6a): Minty's own map, with no outside service.**
- **Drawn like `charts.js`:** an SVG of the world's outline, from Natural Earth's 1:110m countries
  (public domain, about 100 KB simplified, vendored).
- **Airports by IATA code** from OurAirports' list (public domain), the large and medium ones
  (vendored, a few hundred KB), for every flight's two ends.
- **Flights** are great-circle arcs, and **places** are pins: hotels, restaurants and activities that
  have coordinates. Schema.org reservations often include them; a place without any is listed, not
  placed.
- Zoomed to the trip's extent. Tapping a pin shows that booking.
- **Street level:** each place has an **Open in Maps** link (Apple Maps or Google Maps by address).
  It's a link only, so nothing is loaded from them in Minty.
- **No change to the page's policy, and no one else sees where the household is going.**

**Option 2 (T6b): a street map, with OpenFreeMap's tiles (owner, 2026-11-19).**
- [MapLibre GL](https://maplibre.org/), vendored, using its CSP-friendly build with a separate
  worker file.
- **Tiles from [OpenFreeMap](https://openfreemap.org/)'s public instance:** free, no key, no
  cookies, no limits stated. The trip page's policy gains its host (its tiles, styles and fonts), and
  the tile server sees which areas are viewed, not by whom. MapLibre adds OpenFreeMap's and
  OpenStreetMap's attribution.
- Set aside: self-hosted [Protomaps](https://protomaps.com/) PMTiles on Cloudflare R2 (no third
  party, but a few GB to upload and keep up to date). It stays the fallback if OpenFreeMap's public
  instance goes away.
- **Places without coordinates** could be looked up by address (OpenStreetMap's Nominatim, from the
  cron, one request a second, its usage policy followed), or left as a list. ✋

## 14. Live flight status (T6c, optional)

Flighty's main trick: delays, gate changes and landing times as they happen. It needs a
flight-data service; there's no free public source of airline schedules and status.

**Providers** (prices as published in 2026; T0 rechecks them):

| Provider | Cost | Notes |
|---|---|---|
| [AeroDataBox](https://aerodatabox.com/pricing) (RapidAPI / API.market) | a free or trial tier, then from about $5–7.50 a month | status by flight number and date, gates and terminals where airports publish them |
| [FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi/) Personal | billed per query, with about $5 of free use a month | personal or academic use only; good coverage and live positions |

Each household brings its own key (`FLIGHT_STATUS_PROVIDER` as a variable, `FLIGHT_STATUS_KEY` as a
secret). It's off without one.

**Polling, from the cron only** (never on a request, like sync). Per flight leg:
- once 24 hours before, once 6 and once 3 hours before;
- every 10-minute catch-up run from 2 hours before until it departs;
- every 30 minutes until it lands, and once after.

That's about 15–20 calls a leg. `FLIGHT_STATUS_CALLS_PER_DAY` caps them (default 50), so a free tier
isn't overrun. Past the cap, cards say "status paused until tomorrow".

**Stored on the leg:** status (scheduled, delayed, boarding, departed, landed, cancelled, diverted),
scheduled, estimated and actual times, terminal, gate, baggage belt, aircraft, delay in minutes, the
time it was fetched, and the provider. Only the latest is kept.

**Shown:**
- **On the flight card:** "Delayed 45 min · Gate G12 · as of 3 min ago (AeroDataBox)".
- **On the dashboard's status strip,** for a flight within 24 hours: "UA 837 to Tokyo: gate G12,
  on time".
- **Push notifications** to a phone (Web Push, VAPID keys, sent from the cron): **later** (owner,
  2026-11-19), as their own step after T6c.

**Privacy:** the provider learns that someone looked up that flight on that date, from the
household's API account. Nothing else is sent.

**Recommended provider: FlightAware AeroAPI, Personal** (owner: build it, 2026-11-19).
- **Free use:** about $5 a month, with no monthly minimum. Billing is per result set (up to 15
  records), and live flight status is one of the cheaper queries, so the free use covers dozens of
  legs a month at about 15–20 calls a leg. T0 checks the real cost of the status query on the
  household's account.
- **Licence:** for personal use, which a household is. Its rate limit (10 result sets a minute) is
  far above what polling needs.
- **Data:** gates, terminals, estimated and actual times, delays and the aircraft.

**Backup with a free plan: AirLabs** (about 1,000 queries a month). Its free key mostly answers for
the current day, which is what live status needs.

AeroDataBox's free tier (600 "units" a month, where a status call costs several) and AviationStack's
(about 100 calls a month, with no HTTPS on the free plan) are too small or unsuitable. OpenSky is free
but has only aircraft positions, with no schedules, gates or delays.

Minty takes one adapter per provider (`FLIGHT_STATUS_PROVIDER` = `aeroapi` or `airlabs`), so a
household can switch.

**Still to decide:** ✋ the daily cap (default 50). Push notifications come later (decided).

## 15. The trip's timeline (owner, 2026-11-19)

A Google-Timeline-like record of the trip, built after the fact (and refreshed during it): for each
day, **where the household was and when**, on the map, from three sources Minty already has or
gets:

| Source | Gives | From |
|---|---|---|
| **Kos's bookings** | flights (airports, times), hotel stays, reservations, activities, with times and often coordinates | §3 |
| **Immich's photo metadata** | where and when each photo was taken: GPS coordinates, time and time zone, and the city, state and country Immich already worked out | the same API key as §8 (`asset.read`), metadata only, **never the images** |
| **The trip's transactions** | what was bought, where and when: merchant, amount, date (and time when the bank gives it), and the place when Plaid gives it | §6 |

**Stops, from the photos.**
- Photos are grouped in time order. A new stop starts after a gap of more than 90 minutes, or a move of
  more than 500 m.
- Each stop has a time span, a centre, Immich's city, the number of photos, and a link to them in
  Immich.
- A day's stops in order are its path on the map.
- Stays (the hotel) and flights (two airports) are stops of their own, from the bookings, so a day
  with no photos still has a shape.

**Transactions placed on the timeline.**
- **When Plaid gives a place** (a city, sometimes coordinates), the charge goes to the stop nearest in
  time in that city.
- **Otherwise** it goes to that day, listed under the stop whose city matches the merchant's, or
  under "elsewhere that day".
- A booking's charge goes to the booking itself (§6).
- **Plaid's place for a transaction is new to Minty.** A migration adds `location_city`,
  `location_region`, `location_country`, `location_lat` and `location_lon` to `transactions`. Sync
  fills them from Plaid's `location` in the same SQL statement that writes the rest, so there's no
  per-row work in the Worker. Transactions synced before keep none.

**The view.**
- The trip's map (§13) draws each day's path in its own colour, through its stops.
- Beside it, the day as a list: "9:10 Hotel · 10:30–12:15 Senso-ji, 34 photos ↗ · 12:40 Lunch,
  ¥3,200 · 15:00 teamLab (booked) · …".
- Tapping a stop shows its photos' link, its charges and its bookings.

**Computed in the cron, never on a request.**
- After a trip ends, and daily while it's on, the timeline is rebuilt and stored as `trip_stops` (a
  trip, a day, a start and end, a centre, a place name, its sources).
- The photos' metadata is fetched page by page across runs, inside the subrequest limit.
- Grouping is one pass in time order, cheap enough for the CPU limit; T7 measures it on a real trip.

**Privacy.**
- This is the household's own location history, stored in its own D1: trip stops only (times,
  centres, place names, counts), never each photo's coordinates or the photos themselves.
- It's built only for trips, never for days outside one.
- Removing a trip removes its stops.

**T0 checks:** Immich's metadata search returns GPS and city with each asset (and whether a
partner's photos are included). T7 depends on T1 (trips), T3 (transactions) and T5 (the Immich key);
the map is T6a.

## 16. The Kos app (J1, built 2026-11-19)

**Owner's request:** a Wanderlog, Flighty and Immich inspired trip app as a standalone PWA, with
GRAZE's OpenStreetMap map as the model. The look borrows from the two apps; the features are
Kos's own:
- **Flights, the theme and the map look like Flighty:** dark first, big airport codes, a progress
  line, status pills, a boarding-pass card, glowing arcs on a night map.
- **Trips look like Wanderlog:** a cover, a day-by-day plan with a colour per day, and numbered
  markers that match the map's numbered pins.

**Where it lives: Minty's Worker, at `/kos/`, as an app of its own.**
- It has its own manifest (`id`, `scope` and `start_url` `/kos/`), icon, service worker
  (`/kos/sw.js`, cache `kos-…`) and home-screen entry.
- It's behind Minty's Access sign-in and `ALLOWED_LOGINS`, on Minty's D1.
- A separate Worker would have needed its own copy of the data, or a key to read Minty's
  transactions. The owner was fine either way (2026-11-19).
- Each service worker deletes only its own old caches (`minty-…`, `kos-…`).
- Minty's ⋯ menu links to it; the demo leaves it out.

**Built (J1):**
- **Data (migration 0025):**
  - `trips`: name, days, place, travellers.
  - `trip_items`: one per booking (a flight leg, a stay, a car, a train, a restaurant, an event),
    with local times as given (their offset when known), place and coordinates, price or points,
    and the flight's airline, number, airports, terminal, gate and seat. A booking can wait with
    no trip.
  - `trip_transactions`: a trip's confirmed or dismissed transactions, and the booking each paid
    for.
- **API:**
  - `GET/POST/PUT/DELETE /trips`, and `/trips/items`.
  - `POST /trips/read-email`: an `.eml`'s bytes, up to 2 MB, the one route past 16 KiB. It's read
    by `src/kos/` into suggested bookings, and nothing is stored.
  - `GET /trips/{id}/suggestions` (§6).
  - `POST /trips/{id}/transactions` (confirm, dismiss, remove).
  - `GET /transactions?trip_id=`, which starts from the trip's links (`CROSS JOIN`).
  - Read budgets in `test/reads.test.ts`. The booking-price look-ups use `INDEXED BY
    idx_txn_pair`, because the planner chose the date index and read a year.
- **The app (`public/kos/`):**
  - **Trips:** the next flight at the top, with its countdown. Trips as covers. Bookings waiting
    for a trip, and making a trip from them.
  - **A trip:** the itinerary by day, before and after the trip, and bookings with no date. The
    flights as cards, with "add to calendar" (an `.ics` made in the browser). Spending: a total,
    by category and a day, with suggestions to confirm and "Open in Minty" (`/?trip=`).
  - **The map beside the plan (above it on a phone):** the itinerary frames the trip's places, the
    Flights tab its flights. Places either side of the date line are shifted to sit together.
  - **Adding a booking:** typed; pasted text, a PDF (pdf.js) or a screenshot (`/sub-scan?for=kos`),
    all read on the device by `public/kos/kos-parse.js`; or an email file read by the server.
    Every suggestion is checked before it's saved.
- **The map (§13, T6a and T6b together):**
  - MapLibre GL 5.24.0, its CSP build, vendored in `public/vendor/maplibre/` (BSD-3-Clause).
    GRAZE loads it from unpkg; Minty doesn't use CDNs.
  - OpenFreeMap's "liberty" style, and at night GRAZE's palette (`public/kos/map-style.js`).
  - Labels in Latin script only: OpenFreeMap's fonts have no CJK glyphs, so Japanese names drew as
    empty boxes.
  - Airports from OurAirports (public domain): 3,245 with scheduled service, `public/kos/airports.json`.
  - **Policy:** only `/kos/*` and `/vendor/maplibre/*` (the worker fetches tiles under its own file's
    policy) may reach `tiles.openfreemap.org`. The dashboard's policy is unchanged.
- **The dashboard:** `/?trip=ID` shows one trip's transactions, with a link back to Kos.

**Next, after T0:**
- T2: the inbox, the Gmail script and forwarding to the domain;
- T5: Immich albums;
- T6c: live status through AeroAPI;
- T7: the timeline;
- T4: BAM's pending changes.

## 17. Kos on its own (option B, built 2026-11-19)

**Owner's question:** what about someone who wants Kos but doesn't have Minty? Of the three options
(Minty without banks; Kos in the browser alone; Kos as its own Cloudflare app), the owner chose
**B: Kos in the browser**, with no setup at all.

**One app, two places** (`public/kos/store.js`, chosen by `public/kos/mode.js`):

| | **On a Minty** (`/kos/`, mode `minty`) | **On its own** (mode `device`) |
|---|---|---|
| Trips and bookings | Minty's API, on its D1 | IndexedDB in this browser (database `kos`) |
| Email files | read by the Worker (`POST /trips/read-email`) | read in the browser by the same code (`src/kos/` with its types stripped, `kos/mail/`) |
| The trip's spending | yes | no (no transactions); the tab isn't shown |
| Travellers, BAM's programs | from `MINTY_USERS`, `/points` | none |
| Gmail pull (§17.1), Share to Kos (§17.2) | yes | yes |
| The Gmail inbox on Minty (§6), Immich, live status (later) | yes | no: each needs a server |

- **Both stores answer the same calls,** with the same shapes as Minty's API, so `kos.js` doesn't
  care which it has.
- **The device store checks fields** as the server does (`checkTrip`, `checkItem`).
- **The map, the flight cards, the itinerary, paste, PDF and screenshot** work the same in both.

**Your data** (`#/data`, in both modes):
- **Export** writes every trip and booking to a JSON file (`app: "Kos"`, `version: 1`).
- **Import** reads one back, re-tying bookings to their trips. It's how trips move between
  devices, and from Kos on its own into a Minty.
- On its own, Kos asks the browser to keep its data (`navigator.storage.persist()`). The page says
  that clearing the site's data loses the trips, and to export now and then.

**Building and hosting:**
- `node scripts/build-kos.mjs --out <dir>` writes:
  - `kos/`, with `mode.js` set to `device`, the email reader in `kos/mail/` (types stripped by
    Node's `stripTypeScriptTypes`), and those files in the service worker's shell;
  - `vendor/` (MapLibre, pdf.js, Tesseract);
  - the files Kos loads from the root (the screenshot reader, `pdf-read.js`, `lock.js`, `theme.js`);
  - `_headers.kos`: the same security policy as `public/_headers` gives those paths on a Minty.
- **Hosted on the landing site,** `minty.milesmaximizer.com/kos/`. Its `deploy.mjs` runs the build
  after the demo's and installs `_headers`, the same as the demo is built from this repo.
  Nothing is committed there.

**Fixed along the way:**
- `pdf-read.js` found pdf.js relative to the page. From `/kos/` that pointed at `/kos/vendor/…`, so
  reading a PDF in Kos was broken on a Minty too. It now resolves relative to its own file.
- **A Kos bug:** saving a booking from a pasted suggestion did nothing. The form has a
  `data-source` attribute, so a click on it also hit the source tabs, which re-rendered the page.

### 17.0 Trying Kos without trips of your own

- **In the live demo** (`/demo/kos/`, linked from the demo dashboard's ⋯ menu): Kos on a Minty, on
  the demo's made-up household (`demo/data.ts`): a holiday in Lisbon last month, a work trip to
  Chicago tagged "reimbursed" (left out of CFA, §18), Tokyo coming up with its flights paid for, and
  a booking waiting for a trip. The trips' charges are the demo's own transactions, so the Spending
  tab, "Open in Minty" and trip tags all work. `scripts/build-demo.mjs` copies `public/kos/` into the
  demo with checked edits (relative paths, no service worker, no Gmail or screenshot tab).
- **On its own:** an empty Kos offers **Try a sample trip**. It loads the same trips (no people,
  transactions or tags) from `kos/sample.json`, which `scripts/build-kos.mjs` writes from the demo's
  data, dated from a fixed day; `shiftSample` moves them to the visitor's today. They're ordinary
  trips in the browser, marked by localStorage `kos-sample`, and **Remove them** deletes them and
  their bookings.

### 17.4 Kos on its own: set-up first, the device lock last (owner, 2026-11-20)

- **A newcomer's first screen** (`welcome()` in `kos.js`, redesigned 2026-11-20 after Inkling, GRAZE and Minty: a
  narrow column, a big tight headline, raised pills and one solid button, the icon's saffron and teal
  as accents, a made-up flight drawn by the real flight card, and EasyUI's pill navigation, with its
  sliding thumb, for the set-up's steps) is Kos's set-up, not the device lock. "Kos by Minty" heads it; it ends
  with Support on Ko-fi and Star Minty on GitHub, and the rg-code footer. On the landing site only,
  `build-kos.mjs --goatcounter` counts visits and taps (GoatCounter: no cookies, nothing about the
  trips; `kos/gc.js` and the counting hosts in its policy); Kos on a Minty never has it. The set-up:
  1. add trips, automatically (Gmail pull) or by hand (paste, a PDF, an email file, a screenshot,
     typing, or sharing to Kos on Android): one step, since both add trips;
  2. put Kos on the home screen (Install Kos when the browser offers it);
  3. **last:** lock Kos on this device (Turn on / Not on this device), or what this device can't do.
- **`lock.js` on Kos on its own** (`window.KOS_MODE === "device"`, set by `mode.js` before it loads)
  says Kos and trips, shows Kos's icon, and never offers itself on arrival. Once it's on, it unlocks
  as on Minty. Minty, and Kos on a Minty, are unchanged.
- **Once there are trips of the person's own** (not only the sample's) and the lock was never set, the
  home screen ends with **Last step: lock Kos on this device?** until they choose.

**Kos's icon** (the owner's, 2026-11-20): `public/kos/icon-64.png` (favicon, header, the lock),
`icon-192.png`, `icon-512.png`, `maskable-512.png` (the artwork at 80% on its own background,
#014147, inside the safe zone) and `apple-touch-icon.png`, all made from the owner's 1254 px image.
The old SVG is gone.

**The trip list ends like the first screen** (on its own only): Support Kos (Ko-fi, Star Minty on GitHub), the
other rg-code projects and the © line, the same markup (`supportHtml`, `alsoFromHtml`, `copyHtml`).

### 17.5 Backups, and the theme (owner, 2026-11-20)

- **The reminder:** on Kos on its own, when there are trips of one's own (not only the sample's) and
  none has been backed up (or, never, the oldest of them was made) more than 30 days ago, the home
  screen shows "Back up your trips?" for 15 seconds, then it fades and is snoozed for 3 days ("Not now":
  7 days). `backupDue` in `store.js`; the times are in localStorage (`kos-backup-at`, `kos-backup-snooze`).
- **Back up** (the reminder, and Your data): the phone's share sheet with the backup file
  (`kos-backup-<date>.json`, the same as an export), so it goes to Google Drive, an email to oneself,
  Files, or anything else the phone offers; where a browser can't share files, a download. No Google
  sign-in in Kos, and the Gmail script stays read-only. An Export counts as a backup too. Restoring is
  Import, on Your data.
- **Theme:** Kos is light by default (the owner's choice; it was dark, like Flighty). The theme
  button is an airplane window: the shutter is up in light and pulled down in dark, and slides between.

### 17.1 Gmail pull (both modes)

**Why:** on a phone, the Gmail app can't save a message as an `.eml`, so "Email file" alone left Kos
on its own with no way to read a forwarded booking.

**How it works:**
- The person forwards a booking to their Gmail with `+kos` before the @ (**`+trip` on a Minty**, beside
  the planned `+bills` for Bills, owner 2026-11-20). A Gmail filter labels it **Kos** (labelling one by
  hand counts too, and a filter made for the other tag keeps working). A trip's own `+<code>` (§21)
  needs no filter.
- **A forwarded email** has lost its schema.org markup (Gmail drops it when forwarding), so when an email
  has none, Kos reads its text as it reads pasted text (`kos-parse.js`), the HTML part turned to text when
  there's no text part (`htmlText` in `src/kos/mime.ts`), with the year from the email's date (owner,
  2026-11-20). The text reader knows stays laid out with their dates above "Check-In", the year on its own
  line, check-in and check-out times, a street address, long confirmation numbers and points totals,
  with the program named nearest the amount as BAM's id (`programIn`; Wyndham Rewards added to BAM's
  programs for it).
- A short Google Apps Script in their Gmail, deployed as a web app, hands Kos the emails with that
  label. `public/kos/gmail.js` writes the script on the set-up page (`#/gmail`).
  - It runs as the person ("Execute as: Me") and is hosted by Google.
  - It asks only for `gmail.readonly`, in the manifest Kos gives (`appsscript.json`). It never
    changes, moves or sends mail (a test checks the script's text).
  - It answers only a request with the key written into it: 48 random hex characters, made on
    this device. Access is "Anyone", so Kos can call it without a Google sign-in; the key is what
    keeps others out.
  - It returns the label's emails from the last 60 days: at most 20 messages from 30 threads,
    skipping any over 1.5 MB, and skipping the ids Kos says it has already read.
- **Kos reads each email** with `store.readEmail`, the same reader as "Email file". It shows the
  bookings found, with Add and Add all.
- **Read emails are remembered** on this device (localStorage `kos-gmail-seen`, the last 1,000 ids).
  An email counts as read once one of its bookings is added, or after "Don't show these again".
- **The web app's address and the key stay in this browser** (localStorage `kos-gmail`).
- **It checks by itself:** opening "Add a booking" asks the script, and shows only what's new
  ("New in your Gmail"). It says nothing when there's nothing new or the script can't be reached;
  "Check Gmail" on the Gmail tab says why. Switching tabs doesn't ask again. A web app can't check
  in the background on a phone, so nothing happens while Kos is closed.
- **The phone link:** setting up needs a computer (Google's script editor), but the key is made on
  that device. Once connected, the set-up page shows **Connect your phone**:
  - a link, `…/kos/#/gmail?connect=<code>`, where the code is the script's address and the key
    (`linkFor` / `readLink`), and a QR code of it (vendored `qrcode-generator`,
    `public/vendor/qrcode/`, loaded only there);
  - the code is after the `#`, so it's never sent to any server; the page saves it and takes it out
    of the address bar (`history.replaceState`);
  - on a phone not yet connected, the set-up page has a box to paste the link. On an iPhone that's
    the way: the installed app's storage is separate from Safari's, where a scanned link opens;
  - the page says that anyone with the link can read the Kos label.
- **The policy:** `/kos/*`'s `connect-src` allows `https://script.google.com` and
  `https://script.googleusercontent.com`. Apps Script answers from the first by redirecting to the
  second. Nothing else gets those hosts.
- **Recommended:** a Gmail account made just for this, as for Minty's inbox (§6). Google's read-only
  permission covers the whole mailbox, so in an account that only gets what's forwarded, that's all
  the script can see.
- **To stop it:** archive the deployment in Apps Script. "Forget on this device" drops the address
  and the key from Kos.

**How it differs from Minty's inbox (§6):**
- Minty's inbox is a script that sends mail to the Worker, through an Access service token.
- Gmail pull is Kos asking the person's own script from the browser.
- It needs no server, so it works for Kos on its own too.

### 17.2 Share to Kos (both modes)

- **The installed app is a share target** (`share_target` in `kos/manifest.webmanifest`): on Android,
  "Share" from Gmail, Files or the gallery lists Kos. It takes a PDF, an image, an email file or text.
- **The service worker takes the POST** to `/kos/share`. It keeps what was shared in IndexedDB
  `kos-share` (at most 5 files, 20 MB each) and opens `#/add?shared=1`. Nothing leaves the device.
- **The add page reads it once, then deletes it:**
  - a PDF is read with pdf.js;
  - an email file goes to the email reader;
  - text, or a link, goes to the paste parser;
  - a screenshot goes to `/sub-scan?for=kos&shared=1`, which reads it with Tesseract straight away.
- **iPhones have no share targets for web apps.** There, Gmail pull (§17.1) is the way in, or paste.

## 18. Trip tags (Minty only, built 2026-11-19)

**Owner's ask:** tag a trip (say "reimbursed", a tag CFA leaves out of the numbers) and have the
trip's spending left out too.

**How it works:** a trip's tags become real tags on its transactions.
- `trips.tags` holds the trip's tags (at most 10, each up to 64 characters, as typed; one per
  spelling, whatever the case).
- Each tag the trip puts on a transaction is an ordinary `transaction_tags` row marked with the trip
  (`transaction_tags.trip_id`, migration 0026). A row a person added has no mark.
- So everything that reads tags follows, unchanged: the dashboard's tag filter, its "shown" totals,
  and CFA's "Left out of the numbers".

**What happens when:**

| | |
|---|---|
| A tag is added to the trip | every confirmed transaction in it gets the tag, after its own tags |
| A transaction is confirmed into the trip | it gets the trip's tags |
| A tag is taken off the trip | it comes off the rows the trip added; a tag the person added stays |
| A transaction is removed or dismissed | the trip's rows on it go |
| The trip is deleted | its rows stay, as ordinary tags (a reimbursed trip stays left out) |
| A row's tags are edited on the dashboard | the tags it keeps keep their mark (`setTags` updates in place) |

- **A tag already on a transaction stays the person's** (`ON CONFLICT DO NOTHING`), so taking the
  tag off the trip never removes it.
- **CFA follows within minutes:** a tag change (from a trip or the dashboard) that involves a tag
  left out of the numbers marks CFA for a rebuild (`markIfLeftOutTags`, `audit_dirty`), which the
  next cron run does. Before, a hand-tagged left-out tag waited for the weekly rebuild.
- **Reads:** a trip's changes touch only its own transactions, through `trip_transactions`'s key;
  `GET /trips` also reads `analytics_exclusions` (a few rows) to say which tags are left out.
- **The page:** the trip form has Tags, with the household's tags to tap (left-out ones marked). The
  trip's cover shows its tags, and the Spending tab says when they're left out.
- **Not on its own:** Kos on its own has no transactions, so it has no trip tags.
- **One edge:** a transaction in two trips with the same tag carries one row, the first trip's.
  Taking the tag off that trip takes it off the transaction, even though the other trip has it.

## 19. Renamed Kos, and the trip's summary strip (owner, 2026-11-20)

**The rename:** JET is **Kos** everywhere: its name, its address (`/kos/`), its files (`public/kos/`,
`src/kos/`, `src/routes/kos.ts`, `scripts/build-kos.mjs`), the landing site and the demo.
- **Old addresses redirect:** `public/_redirects` sends `/jet` and `/jet/*` to `/kos/…` (301), and the
  landing site does the same, so bookmarks and the dashboard's old trip links still open.
- **Nothing is lost in a browser:** `store.js` moves the old localStorage keys (`jet-gmail`,
  `jet-gmail-key`, `jet-gmail-seen`, `jet-sample`) to their `kos-` names, a newer `kos-` one
  winning. When Kos's IndexedDB database (`kos`) is first made, the trips in JET's (`jet`) are copied
  into it with their ids; JET's database is left as it was.
- **The old app goes:** Kos unregisters JET's service worker (scope `/jet/`) and deletes its `jet-`
  caches. An installed JET opens the redirect in the browser; Kos is installed again once.
- **Old exports import** (`app: "JET"`); new ones say `Kos`.
- **Gmail pull:** new set-ups use the label **Kos** and `+kos`. A script made with the label JET keeps
  working, since Kos never tells the script which label to read.
- **Kept:** `0025_jet.sql` (an applied migration's name is how D1 tracks it), and history.

**The Lodging tab** (2026-11-20, beside Itinerary and Flights): the trip's stays as cards (nights, check-in
and check-out, where, the booking), and the map zooms in on them (`drawTrip`'s "lodging" fit).

**A city photo on a trip's cover** (§19.1, owner, 2026-11-20): Wikipedia's lead image for one of the
trip's cities, hotlinked from Wikimedia Commons, on the trip's card and its cover, under a scrim.
- **Which city** (`cityNames`), best first: a street address's town as Wikipedia titles US places
  ("Town, State", and the part before a hyphen); else the place as typed ("Tokyo, Japan") and its first
  part, never a street; then the city the first day's flights end in (the destination, never a
  connection's stop); the trip's name last. A disambiguation page ("Portland") is skipped. (Owner,
  2026-11-21: a trip with a connection got the connection city's photo.)
- **Which photo:** the page's lead image (Wikipedia's PageImages gives only freely licensed ones), as a
  960 px thumbnail from `thumb.wikimedia.org` or `upload.wikimedia.org`; nothing else is accepted
  (`isWikimediaImage`), and it's set through the DOM, never the page's HTML.
- **Credit:** its photographer and licence (from the file's metadata), on the cover; on the trip's
  page it links to the file on Commons.
- **Asked once per city:** each answer, or "none", is kept in localStorage (`kos-photos-2`; the `-2` dropped the picks made before).
- **What Wikipedia learns:** the city's name and the browser's address, once per city, from the
  browser (on a Minty too). The first screen says so.
- **The policy:** `/kos/*` may reach `en.wikipedia.org` (the lookups) and the two Wikimedia image
  hosts (the photos). Nothing else does.

**The summary strip** (under a trip's cover, like Wanderlog's):
- **Reservations:** Flight, Lodging, Rental car, Train (trains and buses), Restaurant, Activity, Other,
  each with its count. A tap opens "Add a booking" for that trip with that kind chosen
  (`#/add?trip=…&kind=…`).
- **No Attachment tile:** Kos keeps no files (PDFs and emails are read on the device; only their
  fields are saved).
- **Budgeting:** on a Minty, the spending linked to the trip (`spent_cents`), with "View details" to
  the Spending tab, and "left out of CFA" when a trip tag says so. On its own, what the bookings cost,
  from their prices, by currency.
- `tripSummary` (`store.js`) counts; `kos.js` draws it with Material Icons glyphs (Apache 2.0).

## 20. The trip journal (K1, owner, 2026-11-20)

**What it is:** a page for each trip (`#/trip/{id}/journal`, the **Journal** button on the trip's
cover), like Wanderlog's trip journal. It opens any time: before, during or after the trip.

**"On its own" after the trip:** the hourly run marks a trip's journal ready the day after it ends
(`trips.journal_ready_at`, `markJournalsReady`). The home screen then says **Your Lisbon journal is
ready** (trips that ended in the last 60 days) until it's first opened (`journal_seen_at`). On Kos on
its own, a trip that has ended is ready, and this browser remembers which were opened.

**What's in it, written from the bookings** (`public/kos/journal.js`; no AI, so it's free and the same
everywhere):
- **The cover:** the trip's dates and place, days, flights, km flown (great circles between the
  airports), countries (the airports'), places, and on a Minty what it cost (left out of CFA when a
  trip tag says so, §18).
- **A note for the trip**, then each day: its lines ("Flew San Francisco → Tokyo on UA 837", "Checked
  in at…", "Dinner at…" by the booking's time, "Took…"), on a Minty what was spent that day and where,
  and a note for the day. "Getting there" and "Getting home" hold what falls outside the trip's days.
- **The household's notes** are all that's stored: `trip_journal_notes` (migration 0027), one per day
  and one for the trip ('trip'), at most 60, 5,000 characters each, saved as they're typed. On Kos on
  its own they're in IndexedDB (database `kos` version 2, store `notes`), and an export carries them.
- **Print or save as PDF:** the browser's print, with a print layout (no buttons, notes as text).

**The journal's map:** minimal (owner, 2026-11-20; it was EOX's satellite imagery, which the owner found
too busy).
- **OpenFreeMap's Positron**, cut down to land, water, the big roads as faint lines, country borders and
  city names, in a quiet light or dark palette that follows Kos's theme (`minimalStyle`). It's
  redrawn when the theme changes.
- **Over it:** the flights, and the trip's places numbered in the order it went (1, 2, 3… across the
  whole trip, inside the dot, in its day's colour), joined by one line. It opens zoomed in on those
  places; the flights draw without widening it.
- **The credit** (OpenFreeMap, OpenMapTiles, OpenStreetMap) is under the map, and in the map's ⓘ.
- The itinerary numbers its places across the whole trip too (1, 2, 3…; a stay's check-out keeps its
  check-in's number), inside the map's dots, and its map joins them in that order. Its rail is one
  line from the first day to the last, in each day's colour.
- **The trip's own map** (Itinerary, Flights, Lodging) stays OpenFreeMap's Liberty, a little quieter
  (`quietStyle`): no points of interest, buildings, road names or shields, minor streets, footpaths,
  tunnels or state names, and soft grey roads in light. The main roads, rail, parks, water and place
  names stay.

**Reads:** `GET /trips/{id}/journal` reads the trip by its key and its notes by the key's prefix
(budget in `test/reads.test.ts`). The hourly step reads the trips (few).

**K2: Immich in the journal** is §25.

## 21. Each trip's own email address (owner, 2026-11-20)

**Each trip has a code:** 10 characters, lowercase letters and digits without look-alikes (no 0, 1, i,
l or o): about 50 bits, so codes never clash in practice (a unique index makes sure). It never changes.
- **On a Minty:** `trips.code` (migration 0028). The trips already there got theirs in the migration;
  new ones get theirs from the Worker (`newTripCode`), which keeps an imported trip's code when it's free.
- **On its own:** kept with the trip in IndexedDB; trips made before codes get theirs the first time
  they're listed. Exports carry the code, and an import keeps it when it's free.

**The address:** the person's Gmail with `+<code>` before the @ (`you+k7f3x9p2ad@gmail.com`), shown under
the trip's reservations with a Copy button. Kos doesn't know the Gmail address, so the Gmail set-up
page asks for it (optional, kept on this device); until then the trip shows just `+<code>`.

**Gmail pull files by it:**
- Each check sends the codes of the trips still worth mail (coming up, on now, or ended in the last 60
  days) to the person's script, with the address when it's known.
- The script searches the Kos label **or** those codes (`to:` the exact address too, when known), and
  says which trip each email was sent to, from its To, Cc, Delivered-To and X-Original-To. A Gmail
  filter can't match "any +code", so the script does it: no new filter is needed.
- A booking from an email sent to a trip's address shows "→ the trip", and **Add** puts it in that trip.
  Mail to `+kos`, or labelled Kos by hand, comes in as before.
- **Still a tap to add:** a mistyped code, or someone else's mail, never adds anything by itself.
- **A script made before this** reads only the label; Kos says to copy it again and deploy a new version.

### 21.1 Which trip, when it wasn't sent to one (owner, 2026-11-20)

A booking from the Kos label (or pasted, a PDF, an email file) goes in the one trip whose dates cover
its date, or the trip starting the next day (the flight out the night before): `tripFor` in `store.js`.
When two trips fit, or none, it waits for the person to pick, as before. A trip's own address wins over
the dates, and the trip being added to (its Add page) wins over them too. Still a tap to add.

Under the trip's address the summary says so: Kos works this out from the dates, so forwarding to Kos is
enough, and the address is for filing one there for certain (overlapping trips, dates Kos can't read).

**On a Minty's inbox (T2, to come):** `+mintytrips` and `+mintybills` as planned, and a trip's
`+<code>` files into that trip.

## 22. A place to go on any day (owner, 2026-11-20)

**Why:** a day with no booking ("Nothing planned yet") can still have somewhere to go.
- **"+ Add a place"** under every day (and in an empty one) opens a small form: what, where, and an
  optional time. It's saved as an Activity on that day (`kind = 'event'`, no new kind), so it's
  numbered in the itinerary, drawn on both maps and written into the journal.
- **One box for where, with no maps or lookup service** (`public/kos/where.js`, tested):
  - **plus codes:** full ones (`8Q7XPRF9+WQ`) anywhere; short ones (`PRF9+WQ Sumida City, Tokyo`, what
    Google Maps copies) recovered near a reference point. A city named after the code comes first
    (from `airports.json`), then the trip's own places. The recovery always finds the match nearest
    that point, so the hint says which point it used ("about 20 km from Tokyo"), with a Check it link.
    The decoder passes Google's own test data (`test/fixtures/olc-*.csv`, Apache 2.0).
  - **coordinates:** `35.7101, 139.8107`, or degrees, minutes and seconds.
  - **a Google Maps link:** the long address (the place itself, `!3d…!4d…`, before the map's centre).
    A short `maps.app.goo.gl` link only says where after a redirect, which a page can't read: on a
    Minty, the Worker follows it (`POST /trips/place-link`); on its own, Kos asks for the long address.
  - **anything else** is kept as an address, with an "Open in Maps" link, but isn't placed on the map.
  - **what3words** isn't read: it needs their paid service, and Kos says so.
- **The booking form's "Address or place"** reads the same way, so pasting a plus code or a map link
  into any booking puts it on the map.
- **Following a short link** (the Worker): only from `maps.app.goo.gl` or `goo.gl/maps`, at most 3
  hops, each only to a Google host, returning the final address, never a page. Security plan §8.

## 23. Sharing one trip (owner, 2026-11-20)

- **Share** on a trip's cover makes a link to Kos on its own with the trip **in the link**:
  `…/kos/#2.<data>` (§23.1). Nothing is stored anywhere, so there's no short code to type: that would
  need a server to keep trips, and Kos on its own has none (owner, 2026-11-20).
- **Left out:** ids, the trip's code (the one who adds it gets their own), travellers, tags, spending,
  notes; and unless "Include confirmation numbers, prices and guest names" is ticked, those too (a
  booking reference with a surname can be enough to change a booking, and the link stays in the chat).
- **Opening it** shows a preview ("Tokyo · 6 bookings") with **Add this trip**; nothing is added by
  itself. The link is taken out of the address bar, a link can't unpack into more than 256 KB, and
  everything in it is checked like an import. Shared to Kos on Android, a link opens the same preview.
- **On a Minty,** the link opens Kos on its own (the household's /kos/ is behind Access); someone with a
  Minty pastes it on Your data (Add a shared trip), or on **New trip** (above the form: "Someone shared a trip?"). **Download file** saves the same trip as a file.
- **Before adding,** the link opens the whole trip as its page would show it: the cover (with its city photo), the
  map and the plan day by day, read-only (a tap shows a place on the map). **Add this trip** and **Not now** sit on top.

### 23.1 Shorter links, still no server (owner, 2026-11-20)

The first links carried the trip's JSON (`1.`, about 680 characters for the sample's Tokyo trip). `2.` links
carry it as short text instead (`shareText` / `fromShareText` in `store.js`), deflated, in base64url, and
start at `#` rather than `#/import?t=`: the same trip is about 390 characters.
- **Rows and fields:** one row for the trip, one per booking, fields joined by `|`, in a fixed order, so
  no field names. Empty fields at a row's end are left off. A booking's kind is a digit.
- **Dates and times:** days after the trip's first day (`-1` for the flight out the night before), then
  `T` and HHMM. The trip's most common UTC offset is said once; a time in another zone carries its own
  (`-8`, `+5.5`), and `~` marks a time typed with none.
- **Places:** coordinates in 1e5ths of a degree (about a metre), a booking's relative to the trip's.
- **Lost on the way:** a `|` or line break in text becomes `/` or a space; seconds in a time.
- **Old links** (`1.`, `#/import?t=`) still open. A decoded trip is checked like an import, as before.
- **What it can't do:** a link still grows with the trip (about 40 characters a booking). A link that
  stays short whatever the trip would need a server to keep trips.

## 24. Share a trip with the Kos team (owner, 2026-11-20)

**Why** (the owner): people share trips with the Kos team (the owner) to have them **featured** (a demo
or sample trip, a catalog of trips), or as a **bug report**. The page asks which: "Feature it" (the
email then says, as the person's permission, that Kos may use the trip as a sample trip or in a
catalog, with its dates moved and nothing personal; subject "Kos trip to feature: …") or "Something's
wrong" (subject "Kos trip with a problem: …"). Below, what was first built as "Send to the Kos developers":


- **"Share it with the Kos team"** (a line under a trip's plan, and on its Share page) opens a short
  page on Kos on its own with the trip in the link (its share string, never with confirmation numbers,
  prices or guests). It shows what goes, takes an optional note, and **Open email** starts an email in
  the person's own mail app (`mailto:`): to the developers' address, "Kos trip: <name>", with the note and
  the trip's link written in. Nothing is sent until they send it, and Kos has no email server.
- **The address** is a Cloudflare Email Routing alias on the owner's domain (forwarding to them), given
  only to the landing site's build (`scripts/build-kos.mjs --report-to …`, in minty-site's deploy.mjs),
  which writes `kos/report-to.js`. It never goes in this public repo, so from a Minty (or a fork) the
  button opens the landing site's Kos, which knows it.
- **Long trips:** some mail apps cut a `mailto:` past about 2,000 characters; then the email leaves the
  link out and Kos copies it for the person to paste (`reportMail` in `store.js`).
- **The developer** opens the link in any Kos to see the trip as the person did.

**The first screen's lights** (owner, 2026-11-20): one teal and saffron pair in each of three places
down the page (behind the headline, beside the sample flight, behind the set-up), each breathing
(brighter and a touch larger, then dimmer and smaller), out of step with the others; sized in px and
placed so each fades out inside its own section; still for reduced motion.

## 25. K2: the trip's Immich album, in the journal (owner, "build K2", 2026-11-20)

On a Minty with Immich set up, each trip gets an album in Immich of everything taken during it, and the
journal shows a few of each day's photos. Kos on its own has no server, so no Immich. Security plan §9.

**Setting it up** (the household, once):
- **An Immich API key** (Account Settings → API Keys) with `asset.read`, `asset.view`, `album.read`,
  `album.create`, `albumAsset.create`. Secret `IMMICH_API_KEY`.
- **An address Cloudflare can reach**, as the variable `IMMICH_URL`. A Worker can't reach a tailnet, so:
  a Cloudflare Tunnel on the Immich machine, with a hostname used only for this, behind a Cloudflare
  Access application whose only policy is Service Auth for a service token. The token goes in
  `IMMICH_ACCESS_CLIENT_ID` / `IMMICH_ACCESS_CLIENT_SECRET`.
- **`IMMICH_LINK_URL`** (optional): where people open Immich in a browser (the tailnet address, say), for
  the album links. Default `IMMICH_URL`.
- Setup (`/status`) shows the cron's daily check of the key: it works, and has what Kos needs.

**The album** (`src/immich.ts`, from the cron only: one trip per quiet catch-up run):
- **Which trips:** one someone asked for (**Make the album now**); one that ended in the last 7 days with
  no album yet; and one with an album, once a day for 7 days after it ends, for photos uploaded late.
  **Older trips get an album only when asked,** so the first run never fills Immich with albums for
  every past trip.
- **Which photos:** Immich's metadata search over the trip's days with a day either side (UTC), then
  only those whose local time (`localDateTime`, the camera's) falls on the trip's own days. No time
  zone is needed for the trip. 60 a page.
- **The album:** "Tokyo, Mar 2027", made with the trip's first photo (**never empty**: a trip with none
  says so, and can "Look again"; one photo keeps Immich's answer small), then the rest added 500 at a
  time (Immich answers "duplicate" for one already there).
- **CPU (10 ms on the free plan):** each run reads at most about 150 KB of Immich's answers, the budget
  sync measured for Plaid's pages (`SYNC_MAX_BYTES_PER_RUN`); a bigger trip carries on next run. It's
  carried over from sync's measurement, not measured on Immich: `--k2` prints a real page's size. A
  search page is bound once, into a holding row (`app_state`) that SQLite unpacks with `json_each`.
- **A run cut off part-way** leaves the trip saying so ("didn't finish") and waiting an hour. Immich's
  step is the last of the quiet run, so it never costs the steps before it.
- **Failures** are kept on the trip and shown in its journal ("Immich: …"); the trip waits an hour, and
  the oldest-checked trip goes first. Only Immich's own not-found means an album was deleted: then Kos
  doesn't make it again by itself, and the journal offers **Make it again**. A redirect (Access's
  sign-in), a web page, a 5xx or no answer is a passing failure.
- **What D1 keeps** (`trip_photos`, migration 0029): each photo's id, local time and day, coordinates and
  city when Immich has them, whether it's in the album, and the cron's **picks**: up to 6 a day, spread
  through the day, so the journal reads the same few rows however many photos there are. Never an image.

**In the journal:**
- A card: "214 photos and videos from these days, in an album in Immich", **Open the album in Immich ↗**
  (`IMMICH_LINK_URL`), or the album's state (being made, none those days, deleted) and its button.
- A photos count among the stats, and under each day its picks as thumbnails, with "+N more" (all of
  them link to the album).
- Grey dots on the map where photos were taken, when Immich knows (phones often don't record it).
- **Thumbnails come through the Worker** (`GET /trips/{id}/photos/{asset}`): only a photo of that trip,
  only as an image, privately cached. The page never talks to Immich and its policy needs no new host.
  (This replaces §8's "no thumbnails in Minty".)

**Calls Kos makes:**
- **Confirmed by T0:** `POST /api/search/metadata` (`takenAfter`, `takenBefore`, `size`, `page`,
  `withExif`, `nextPage`); `POST /api/albums` (`albumName`, `assetIds`); `PUT /api/albums/{id}/assets`
  (`ids`, "duplicate"); `GET /api/api-keys/me`.
- **From Immich's API, not yet checked on the household's Immich:** each asset's `localDateTime` (Kos
  falls back to `fileCreatedAt`); `GET /api/assets/{id}/thumbnail?size=thumbnail`; `GET
  /api/albums/{id}?withoutAssets=true` and what it answers for a deleted album (Kos takes a 400 or 404
  saying "not found" or "no album.read access"). `scripts/kos-t0/immich.ts --k2` checks them.

**Reads:** `GET /trips/{id}/photos` reads the trip by its key and the picks by `(trip, pick)` (budget in
`test/reads.test.ts`); a thumbnail reads one row by the primary key.

## 26. Kos pools waiting bookings into trips (owner, 2026-11-20)

"The idea was for Kos to figure out and pool bookings towards a trip that it automatically creates."
When the trip list opens with bookings waiting for a trip, Kos files them by itself (`planTrips` in
`store.js`, pure and tested):
- **Into a trip they fall in:** a booking whose date is inside one existing trip (or the day before it
  starts) goes in it, as `tripFor` decides for a new booking (§21.1).
- **Else new trips, grouped by date:** sorted by start; a booking within 2 days of a group's end joins
  it. A group that starts with a flight stays open, up to 30 days, until a flight lands back where it
  left from, so the flight home belongs to the trip.
- **Each new trip:** named for where it goes (its stay's town from the address, else the city the
  first day's flights end in, from airports.json, else the stay's name), with its place and the
  bookings' first to last day, and every person as a traveller.
- **Kos says so:** "Kos put 3 waiting bookings in 2 new trips: …", with links, **Undo** and OK. Undo
  deletes the new trips (their bookings wait again) and takes the moved ones back out; those bookings
  aren't pooled again on this device (`kos-auto-skip`). Undated bookings, and the sample's, wait, and so
  does a group with no travel in it (no flight, stay, train, bus or car): a dinner isn't a trip.
- **By hand still works:** "Make a trip from the ticked ones" opens the trip form filled in the same
  way (name, dates, place), listing the bookings going in.
- **A trip's dates follow its bookings** (owner, 2026-11-21): a trip made from the first emails can end
  before a booking added later. Then the trip page says "1 booking is outside this trip's dates" with
  **Update the dates to …** (`tripSpan` in `store.js`): the earliest start to the latest end of its
  bookings, never narrower than the trip already is (planned free days stay).
- **Read again** (a booking deleted by mistake): Kos skips emails it read before, so a deleted booking
  wouldn't come back by itself. "Deleted one? Read again" on the Gmail tab asks the script without the
  skip list and offers only the bookings no longer in Kos: matched by the email's SHA-256 with the
  booking's kind, day and airport, or by confirmation, kind and day for one typed in. (Forwarding the
  email again also works: it's a new email.)
- **Check Gmail from anywhere:** a magnifier in Kos's header opens Add booking with Gmail's results (on a
  trip, for that trip), turning while it checks; on a Minty it checks for bills too. Before Gmail is set
  up, it opens the set-up page. The demo has none.
- **A connection is one booking** (`journeys` in `store.js`): flights with the same confirmation, each
  leaving within a day of the last landing, show and count as one ("UA 100 · SFO → ORD → BOS, 1
  connection") in the waiting list, the found-bookings count and Kos's note. Each leg stays its own item
  underneath (its own times, gate and seat).
- **A flight's date** (`kos-parse.js`): the date nearest its airports, before or after (an itinerary heads
  a day's legs with the date; a receipt's date is further away). Dates on a forwarded email's header
  line ("Date: …") or saying when it was booked or issued ("Issue date", "Booked on", "Purchased") are
  left out. "26NOV" dates are read too. (Owner, 2026-11-21: a forwarded eTicket was dated by when it was
  booked.)

## 27. Reading bookings, tested against six made-up travellers (owner, 2026-11-21)

The owner: "so far all booking I sent required custom parser and broke multiple times." So the reader was
tested against six made-up travellers instead of one email at a time: a US family, a business traveller, a
budget traveller in Europe, a points-and-miles traveller, a couple who book through online agencies, and a
points family of three. 100 emails, pastes, PDFs and screenshots, 139 bookings, 19 trips, each with the right
answer written down. They were written by subagents from memory of each company's layout: not real
inboxes, so the categories of failure are sound and the exact rates less so. The corpus and its harness are
kept outside this repository.

**Before:** 64 of 139 bookings found, 14 invented, 11 of 100 files fully right. Emails with schema.org markup
read well; forwarded emails, HTML-only emails, PDFs, pastes and screenshots didn't. Trip pooling (§26) was
not the problem: given the right bookings it made all 19 trips with the right bookings and dates.

**The reader now** (`public/kos/kos-parse.js`), general rules only, nothing for one company's layout:
- **Dates:** day-first numbers ("16/04/2027", "16.04.2027", "13-06-2027"), two-digit years ("16 Apr 27"),
  "26NOV27", "18. 9. 2027". A date without a year is the next one after the email's date (or today, for a
  paste). Left out: a forward's header, when it was booked, issued, purchased or printed, until when it can
  be cancelled or paid, and a schedule change's old times ("was", "original flight", "no longer valid").
- **Times:** "4 PM", "15h00"; not durations ("1h56", "4:35 h"); "12:25 Amsterdam" isn't "12:25 AM".
- **Money and points:** any currency and format ("€ 89,99", "1 250 Kč", "13,970 yen"); a total, not a
  subtotal; miles + cash ("52,500 Miles + 168,46 €"), points totals over per-night rows, never miles earned
  or a balance. With markup (which lists the cash only) the points still come from the text.
- **Flights:** two airports (a code, "(XXX)", "(ORD - O'HARE)", or an airport's name when no code is
  printed) with the dates and times nearest them, read as a block when the flight number comes first. A
  flight number may follow its airports, or be "Flight # 2316" (the airline from the email), "Delta 1387",
  "EZY4873"; never an aircraft ("A321"). A summary line that other legs connect, a receipt's fare lines and
  connection notes aren't flights.
- **Trains, buses, events, tours, restaurants, transfers** are read from text too; stays find their names
  ("Your stay at …") and addresses (with postcodes abroad); cars "Trip starts … / Trip ends …".
- **A cancellation** comes back marked; **a marketing email** gives nothing (unless something in it is
  anchored like a real booking).
- **Markup listing a flight once per passenger** gives one flight (`reservations.ts`).
- **An email forwarded as an attachment** is read from the attached original, markup and all
  (`attachedMessage` in `src/kos/mime.ts`).

**A booking read again** (owner: update): `matchBooking` in `store.js` finds the one Kos has (the same
flight by number and day or route and day, or the same confirmation and kind). The suggestion then says
"Already in Kos", or "In Kos · new time" with **Update** (only the fields that changed; its trip stays),
or for a cancellation "Cancelled" with **Delete from Kos**.

**The real-data check** (`scripts/kos-t0/parse.ts`, T0 check 1): the household's own `.eml` files (and
pasted `.txt`) through the same reader Kos uses (`readEmailBookings` in `kos-parse.js`, shared with Kos's
Gmail and email-file paths), on their machine. It prints how each was read (an attached original's markup,
the email's own, or its text), every booking with its fields (confirmations masked unless `--codes`), and
the trips Kos would make. Nothing is saved or sent.

**Trip names:** the city of the stay with the most nights (from its address: "50123 Florence", "Tokyo
105-0001", "Lake Delton, Wisconsin 53940"), else the airport where the flights stop longest (a day trip's
turnaround, not home; a destination, not a connection).

**After:** on the four travellers the rules were tuned with, 79 of 81 bookings found, none invented; on the
two held out (their baseline failures were seen before the rewrite, but they weren't run while iterating),
43 of 58 (from 27), 6 invented (4 of them bookings found
under another kind than the answer's: a tour as an event rather than "other"). All six: 122 of 139 (from 64).
Still missed in the held-out travellers: a corporate travel agency's itinerary, a multi-leg airline e-ticket
PDF, an HTML-only car rental, a screenshot of a car-sharing trip, an airline receipt laid out by date
codes, and a concert in Czech.

