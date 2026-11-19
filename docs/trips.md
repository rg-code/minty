# Plan: trips (a Flighty and Wanderlog hybrid)

**Status: plan, for the owner's review (2026-11-19). Nothing is built.** Working name **JET**
(✋ the owner picks the name, §12).

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

## 2. Getting bookings in

The owner doesn't want Minty connected to a mail account (2026-11-19), and asked whether a
dedicated mailbox would be easier. The options:

| | **Forward to Minty** (Cloudflare Email Routing → an Email Worker) | **A dedicated mailbox Minty reads** (e.g. a new Gmail, Gmail API) |
|---|---|---|
| How | An address on the household's domain (e.g. `trips@…`) is routed to a small Email Worker. Forward confirmations to it, or have an inbox rule forward them. | Minty's cron reads a mailbox through the provider's API, with an OAuth refresh token stored as a secret. |
| Setup | Email Routing on a domain whose DNS is on Cloudflare (free; subdomains work), one route to the Worker. | A Google Cloud project, an OAuth consent screen, the `gmail.readonly` scope (restricted). Left in "Testing", Google expires the refresh token every 7 days; "In production" but unverified, it works for a few users with Google's warning screen. |
| What Minty holds | Nothing: mail is pushed to it. | A credential that reads that whole mailbox. |
| Speed | Seconds after forwarding. | At the next cron run (10 minutes). |
| Failure modes | A message from someone not allowed is dropped. | Token revoked or expired, consent re-done, API quota. |
| Per fork | Needs a domain on Cloudflare (optional feature). | Needs each household's own Google project. |

**Recommendation: forward to Minty.** It's less to set up, Minty holds no mail credential, and it's
instant.
- A dedicated mailbox is still useful as a **collector**: a new Gmail (or the household's own
  inbox) with a filter that auto-forwards travel mail to the Minty address. That gives an archive
  of what was sent, without Minty reading it.
- Gmail's auto-forwarding asks the forwarding address to confirm. The Email Worker recognises
  Google's confirmation message and shows its link in Minty, so the owner can click it.

**Who's accepted:** a message is processed only when it's from an address in `ALLOWED_LOGINS`
(or the collector address) and Cloudflare's checks pass (SPF/DKIM, in the message's
`Authentication-Results`). Anything else is dropped silently, with no bounce.

**Also, without email:**
- **Paste, PDF or screenshot,** reusing SUB's on-device readers (`pdf-read.js`, `/sub-scan`'s
  Tesseract).
- **Share to Minty** on Android: the installed app takes a shared screenshot or PDF (`share_target`
  in the manifest). iOS doesn't support this for web apps; there, it's a screenshot picked in Minty.
- **Wallet passes and calendar files** (`.pkpass`, `.ics`) as a later step.

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
fit, the Email Worker only checks the sender and stores the message's text parts (capped at
256 KB), and the cron parses a few per run, as sync handles Plaid's pages.

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
- **`trip_inbox`:** forwarded messages waiting to be read or confirmed. It keeps the extracted
  fields, plus the message's text for 30 days so a parser fix can read it again, then deletes it.
  ✋ Decide whether to keep the text that long.
- **`trip_transactions`:** links a transaction to a trip, by the owner (confirmed) or suggested
  (§6). Indexed on `(trip_id, transaction_id)`.

## 5. The view

In the ⋯ menu, as a popup like SUB.
- **Upcoming first:** the next trip's countdown and its first flight's card.
- **Each trip:** the itinerary by day, its flights, the transactions panel, points and the album.
- **The person switch** filters by who's travelling: each booking keeps the names on it, mapped
  to `MINTY_USERS` people where they match. It's a filter, as everywhere.
- **Optional later:** a map of the trip's places (map tiles from another host need that host in
  the policy) and live flight status (§11, T6). ✋

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

The owner's Immich is behind Cloudflare Access, so Minty needs:
- the Immich address;
- an Immich API key, as the secret `IMMICH_API_KEY`;
- an Access service token for Immich's application (`IMMICH_ACCESS_CLIENT_ID` /
  `IMMICH_ACCESS_CLIENT_SECRET`), sent as Access's service-token headers.
- All three are secrets, never returned to a page. ✋

**When:** from the cron, never on a request. The first run after a trip ends makes the album, and
it's checked once a day for the next 7 days for photos uploaded late.

**How**, to check against the household's Immich version in T0:
1. Search the assets taken between the trip's start and end, in the trip's time zone (Immich's
   metadata search, paged).
2. Create an album named after the trip with them, and add new ones on the later checks.
3. Keep the album id on the trip.

The trip shows **"Photos: N in Immich ↗"**, a link to the album in Immich, which opens behind
Access for the household. No public shared link is made.

**Whose photos:** an API key belongs to one Immich user. With partner sharing in Immich, that
user's search covers the partner's shared photos too. ✋ Decide which user's key.

**Budget:** each run stays well inside the 50 subrequests (search pages plus one album call).

## 9. Security and privacy

- **The Email Worker:** accepts only allowed senders with passing checks (§2). It never replies,
  never follows links in a message (Google's forwarding confirmation is shown, not clicked), and
  never loads remote images.
- **Forwarded mail is untrusted text.** It's parsed, never executed. HTML is never rendered: the
  trip view shows extracted fields, and the stored text is shown as plain text.
- **What's kept:** extracted fields, a SHA-256 per message, and the text for 30 days (§4, ✋).
- **Secrets:** Immich's and Access's are Worker secrets. No new browser hosts, except a map's tiles
  if T6 adds one.
- **Trust model unchanged:** every allowed login sees every trip.

## 10. Limits

- **CPU (10 ms):** parsing in the Email Worker or, if it doesn't fit, in the cron with a budget
  (§3, T0).
- **D1 reads:** the trip view reads its trips, items and links by index. Suggestions read the
  trip's date window by the date index, bounded at both ends. Each route gets a budget in
  `test/reads.test.ts`.
- **Immich:** cron-only, paged, and inside the subrequest limit.

## 11. Phases (each ends with a PR the owner reviews)

| Phase | What | ✋ |
|---|---|---|
| **T0 Spikes** | Email Routing on the household's domain, a route to a test Email Worker; CPU to parse ~20 real confirmations (the owner forwards them; only their measurements are kept); Immich's search and album API on the owner's version | Domain, Immich key, test emails |
| **T1 Trips and bookings** | `trips`, `trip_items`; typed, pasted, PDF and screenshot input; the itinerary and flight cards | Name |
| **T2 Email in** | The Email Worker, `trip_inbox`, JSON-LD and known-sender parsers, Gmail's forwarding confirmation | The forwarding address |
| **T3 Transactions** | Suggestions, confirm, totals, `/?trip=` in the dashboard | |
| **T4 BAM** | Pending changes from award bookings | |
| **T5 Immich** | Albums from the cron, the link on the trip | Secrets |
| **T6 Optional** | Live flight status (a provider and its key, cron-only, a daily budget), a map | Provider, cost |

## 12. Decisions for the owner

1. ✋ **The name** (JET, or another).
2. ✋ **How bookings come in:** forward to Minty (recommended), with an optional collector inbox
   that auto-forwards; or a dedicated mailbox Minty reads.
3. ✋ **Keep a forwarded message's text 30 days** for re-reading, or only its extracted fields.
4. ✋ **Immich:** whose API key, and the service token for Immich's Access application.
5. ✋ **Live flight status and a map:** later (T6), or not at all.
6. ✋ **Owner-only or for forks:** email ingest needs a domain on Cloudflare, so for forks it would
   be off unless set up (paste, PDF and screenshot always work).
