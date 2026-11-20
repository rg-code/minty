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

**When:** from the cron, never on a request.
- The first hourly run after a trip ends makes the album.
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
- There are no thumbnails in Minty: they'd come from Immich's host, which the page's policy doesn't
  allow, and would need Immich's sign-in in Minty's page.

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
| **T4 BAM** | Pending changes from award bookings | |
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

### 17.1 Gmail pull (both modes)

**Why:** on a phone, the Gmail app can't save a message as an `.eml`, so "Email file" alone left Kos
on its own with no way to read a forwarded booking.

**How it works:**
- The person forwards a booking to their Gmail with `+kos` before the @. A Gmail filter labels it
  **Kos** (labelling one by hand counts too).
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
- **Which city:** the trip's place as typed ("Tokyo, Japan"), then its first part, then the city its
  first flight lands in (`cityNames`). A disambiguation page ("Portland") is skipped.
- **Which photo:** the page's lead image (Wikipedia's PageImages gives only freely licensed ones), as a
  960 px thumbnail from `thumb.wikimedia.org` or `upload.wikimedia.org`; nothing else is accepted
  (`isWikimediaImage`), and it's set through the DOM, never the page's HTML.
- **Credit:** its photographer and licence (from the file's metadata), on the cover; on the trip's
  page it links to the file on Commons.
- **Asked once per city:** each answer, or "none", is kept in localStorage (`kos-photos`).
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
- The itinerary's map numbers its places inside the dots too (per day, as Wanderlog does).
- **The trip's own map** (Itinerary, Flights, Lodging) stays OpenFreeMap's Liberty, a little quieter
  (`quietStyle`): no points of interest, buildings, road names or shields, minor streets, footpaths,
  tunnels or state names, and soft grey roads in light. The main roads, rail, parks, water and place
  names stay.

**Reads:** `GET /trips/{id}/journal` reads the trip by its key and its notes by the key's prefix
(budget in `test/reads.test.ts`). The hourly step reads the trips (few).

**Next, K2: Immich in the journal** (§8, waiting on T0): the album, its photos on their days and as
pins where they were taken, thumbnails through the Worker (only the trip album's), and **Make the
album now**.

