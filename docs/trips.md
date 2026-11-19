# Plan: trips (a Flighty and Wanderlog hybrid)

**Status: plan, for the owner's review (2026-11-19). Nothing is built.** Its inbox (§2) also serves Bills. Working name **JET**
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
- This is a change to the security model: a security-plan entry, approved before T2. ✋

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
- **A PDF attachment** is the open question. Bills' rule today is that PDFs are read in the browser
  and never uploaded, only their fields and SHA-256 saved. A forwarded PDF has already gone through
  the household's mailbox, but keeping it in D1 until a browser reads it changes that rule. ✋ The
  options:
  - **(a)** Keep the attachment in the inbox (up to 2 MB, D1's row limit), read by pdf.js when Bills
    next opens, then delete it at once (or after 30 days if never read).
  - **(b)** Ignore attachments: only the email's text is read, and a bill that's only in a PDF is
    added from the PDF as today.
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

- **What gets in:** only mail the household chose (§2): labeled in Gmail and sent with the
  household's access key, or forwarded from an allowed login to the domain's address. Minty never
  replies, never follows a link in a message, and never loads remote images.
- **Forwarded mail is untrusted text.** It's parsed, never executed. HTML is never rendered: the
  trip view shows extracted fields, and the stored text is shown as plain text.
- **What's kept:** extracted fields, a SHA-256 per message, and the text for 30 days (§4, ✋).
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
| **T0 Spikes** | An Apps Script posting through Access with a service token, and that token's JWT claims; Email Routing on the owner's domain to a test handler; CPU to parse ~20 real confirmations (the owner sends them; only their measurements are kept); Immich's search and album API on the owner's version | Service token, Immich key, test emails |
| **T1 Trips and bookings** | `trips`, `trip_items`; typed, pasted, PDF and screenshot input; the itinerary and flight cards | Name |
| **T2 Gmail (default)** | The inbox (`inbox_messages`, shared by views), `POST /inbox` for the household's Access service token, the Apps Script and its Setup page (Copy script, the filter text for `+mintytrips` and `+mintybills`), JSON-LD and known-sender parsers, SETUP.md's steps (a Gmail account for Minty), the security-plan entry | Approve the security change |
| **T2c Bills by email** | `+mintybills` messages read with `bill-parse.js` into suggested bills; attachments as decided (§2.3) | Attachments (a) or (b) |
| **T2b Forward to Minty** | The `email()` handler in Minty's Worker for a domain on Cloudflare, the allowed-login check, a Setup check | The owner's forwarding address |
| **T3 Transactions** | Suggestions, confirm, totals, `/?trip=` in the dashboard | |
| **T4 BAM** | Pending changes from award bookings | |
| **T5 Immich** | Albums from the cron, the link on the trip | Secrets |
| **T6 Optional** | Live flight status (a provider and its key, cron-only, a daily budget), a map | Provider, cost |

## 12. Decisions for the owner

1. ✋ **The name** (JET, or another).
2. **How bookings come in: decided (2026-11-19).** The Gmail script by default, with mail labeled
   only by `+minty` forwarding or by hand; forwarding to the domain's address where there's a domain
   on Cloudflare (the owner has both); paste, PDF, screenshot and share for everyone (§2).
3. ✋ **Keep a forwarded message's text 30 days** for re-reading, or only its extracted fields.
4. ✋ **Immich:** whose API key, and the service token for Immich's Access application.
5. ✋ **Live flight status and a map:** later (T6), or not at all.
6. **For forks too:** the Gmail script works for any household with a Gmail account, forwarding to
   Minty for those with a domain on Cloudflare, and paste, PDF and screenshot always.
7. ✋ **The Gmail script's security change:** one route that accepts the household's Access service
   token instead of a person's login (§2.1).
8. **A Gmail account made for Minty: recommended (decided 2026-11-19),** shared by Trips
   (`+mintytrips`) and Bills (`+mintybills`).
9. ✋ **Bills' PDF attachments:** kept until a browser reads them, or ignored (§2.3).
