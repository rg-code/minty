import { describe, expect, it } from "vitest";
import { decodeWords, quotedPrintable, readMessage, viewOf } from "../src/kos/mime";
import { jsonLd, reservations } from "../src/kos/reservations";

// Kos's email reading (docs/trips.md §2, §3): made-up messages, shaped like real confirmations.
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const qp = (s: string) => [...new TextEncoder().encode(s)].map((b) => (b === 61 || b > 126 ? `=${b.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(b))).join("")
  .replace(/(.{70})/g, "$1=\n");

const flightHtml = `<html><head><script type="application/ld+json">${JSON.stringify([
  { "@context": "http://schema.org", "@type": "FlightReservation", reservationNumber: "ABC123", underName: { "@type": "Person", name: "Alex Example" },
    reservationFor: { "@type": "Flight", flightNumber: "837", airline: { "@type": "Airline", name: "United", iataCode: "UA" },
      departureAirport: { "@type": "Airport", name: "San Francisco", iataCode: "SFO" }, departureTime: "2027-03-10T11:05:00-08:00",
      arrivalAirport: { "@type": "Airport", name: "Tokyo Narita", iataCode: "NRT" }, arrivalTime: "2027-03-11T15:00:00+09:00", departureTerminal: "I" },
    airplaneSeat: "34K", totalPrice: "1240.60", priceCurrency: "USD" },
  { "@context": "http://schema.org", "@type": "FlightReservation", reservationNumber: "ABC123",
    reservationFor: { "@type": "Flight", flightNumber: "838", airline: { "@type": "Airline", name: "United", iataCode: "UA" },
      departureAirport: { "@type": "Airport", iataCode: "NRT" }, departureTime: "2027-03-20T17:00:00+09:00",
      arrivalAirport: { "@type": "Airport", iataCode: "SFO" }, arrivalTime: "2027-03-20T10:10:00-07:00" } },
])}</script></head><body><p>Your trip is confirmed — ¡gracias!</p></body></html>`;

const flightEmail = [
  "Delivered-To: ourminty+mintytrips@gmail.com",
  "From: Alex <alex@example.com>",
  "To: ourminty+mintytrips@gmail.com",
  `Subject: =?utf-8?B?${b64("Fwd: Your United trip ✈ confirmed")}?=`,
  "Date: Mon, 01 Feb 2027 09:00:00 -0800",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  qp("Your trip is confirmed — ¡gracias! Confirmation ABC123."),
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64(flightHtml).replace(/(.{76})/g, "$1\n"),
  "--b1--",
  "",
].join("\r\n");

describe("readMessage", () => {
  it("headers, an encoded subject, text and HTML in base64 and quoted-printable, and the view from +mintytrips", () => {
    const m = readMessage(flightEmail);
    expect(m.subject).toBe("Fwd: Your United trip ✈ confirmed");
    expect(m.from).toBe("alex@example.com");
    expect(m.to).toEqual(["ourminty+mintytrips@gmail.com"]);
    expect(m.text).toBe("Your trip is confirmed — ¡gracias! Confirmation ABC123.");
    expect(m.html).toContain("FlightReservation");
    expect(m.attachments).toEqual([]);
    expect(viewOf(m)).toBe("trips");
  });

  it("a forwarded message attached whole, a PDF attachment, and +mintybills", () => {
    const inner = ["From: Utility <billing@utility.example>", "Subject: Your bill is ready", 'Content-Type: text/html; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable", "", "Amount due: $84.12 =E2=80=94 due Dec 3 (caf=E9)"].join("\r\n");
    const raw = ["From: Sam <sam@example.com>", "To: Ourminty <OURMINTY+MINTYBILLS@gmail.com>", "Subject: Fwd: Your bill", 'Content-Type: multipart/mixed; boundary="m"', "",
      "--m", "Content-Type: text/plain", "", "See attached.", "--m", "Content-Type: message/rfc822", "", inner,
      "--m", 'Content-Type: application/pdf; name="bill.pdf"', 'Content-Disposition: attachment; filename="bill.pdf"', "Content-Transfer-Encoding: base64", "",
      b64("%PDF-1.4 made up"), "--m--", ""].join("\r\n");
    const m = readMessage(raw);
    expect(viewOf(m)).toBe("bills");
    expect(m.text).toBe("See attached.");
    expect(m.html).toContain("Amount due: $84.12");
    expect(m.attachments.map((a) => [a.filename, a.contentType, a.size])).toEqual([["bill.pdf", "application/pdf", 16]]);
    expect(new TextDecoder().decode(m.attachments[0].content)).toBe("%PDF-1.4 made up");
  });

  it("no view for an address without +mintytrips or +mintybills; trips@ and bills@ on a domain", () => {
    const m = (to: string) => readMessage(`To: ${to}\r\nSubject: x\r\n\r\nhi`);
    expect(viewOf(m("someone@gmail.com"))).toBe(null);
    expect(viewOf(m("ourminty+other@gmail.com"))).toBe(null);
    expect(viewOf(m("trips@example.com"))).toBe("trips");
    expect(viewOf(m("Bills <bills@example.com>"))).toBe("bills");
  });

  it("decodes encoded words and soft line breaks", () => {
    expect(decodeWords("=?iso-8859-1?Q?Caf=E9_reservation?=")).toBe("Café reservation");
    expect(new TextDecoder().decode(quotedPrintable("long=\nline =3D ok"))).toBe("longline = ok");
  });
});

describe("reservations (schema.org JSON-LD)", () => {
  it("each flight leg, with its airline, airports, times with offsets, terminal, seat and price", () => {
    const r = reservations(readMessage(flightEmail).html);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: "flight", confirmation: "ABC123", name: "United", guest: "Alex Example", start: "2027-03-10T11:05:00-08:00",
      end: "2027-03-11T15:00:00+09:00", price_cents: 124060, currency: "USD", points: null,
      flight: { airline: "UA", number: "837", from: "SFO", to: "NRT", terminal: "I", gate: null, seat: "34K" } });
    expect(r[1].flight).toMatchObject({ number: "838", from: "NRT", to: "SFO" });
  });

  it("a hotel with its address and coordinates; a restaurant; an award booking in miles; a broken block skipped", () => {
    const html = `<script type="application/ld+json">{"@type":"LodgingReservation","reservationNumber":"H-77","checkinTime":"2027-03-11T15:00:00+09:00","checkoutTime":"2027-03-15T11:00:00+09:00",
      "reservationFor":{"@type":"LodgingBusiness","name":"Hotel Example","address":{"streetAddress":"1-1 Example","addressLocality":"Tokyo","addressCountry":"JP"},"geo":{"latitude":35.68,"longitude":139.76}},
      "totalPrice":"88000","priceCurrency":"JPY"}</script>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">{"@graph":[{"@type":"FoodEstablishmentReservation","reservationNumber":"R9","startTime":"2027-03-12T19:30:00+09:00",
        "reservationFor":{"@type":"Restaurant","name":"Sushi Example","address":"2-2 Example, Tokyo"}},
        {"@type":"FlightReservation","reservationFor":{"flightNumber":"1","airline":{"iataCode":"NH"},"departureAirport":{"iataCode":"HND"},"arrivalAirport":{"iataCode":"ITM"}},"totalPrice":"35000","priceCurrency":"miles"}]}</script>`;
    expect(jsonLd(html)).toHaveLength(2);
    const r = reservations(html);
    expect(r.map((b) => b.kind)).toEqual(["lodging", "restaurant", "flight"]);
    expect(r[0]).toMatchObject({ name: "Hotel Example", place: "1-1 Example, Tokyo, JP", lat: 35.68, lon: 139.76, price_cents: 8800000, currency: "JPY" });
    expect(r[1]).toMatchObject({ name: "Sushi Example", start: "2027-03-12T19:30:00+09:00", place: "2-2 Example, Tokyo" });
    expect(r[2]).toMatchObject({ points: 35000, price_cents: null, currency: null, flight: { airline: "NH", from: "HND", to: "ITM" } });
  });

  it("nothing from an email without markup", () => {
    expect(reservations("<p>Thanks for your order</p>")).toEqual([]);
    expect(reservations(null)).toEqual([]);
  });
});

describe("an HTML part as text (a forwarded email has no markup left to read)", () => {
  it("keeps the words and the line breaks, drops tags, styles and scripts, decodes entities", async () => {
    const { htmlText } = await import("../src/kos/mime");
    const html = `<html><head><style>p{color:red}</style><title>x</title></head><body><script>var a = 1;</script>
      <table><tr><td>Check-In</td><td>4:00&nbsp;p.m.</td></tr><tr><td>Checkout</td><td>10:00 a.m.</td></tr></table>
      <p>Total for Stay&nbsp;&nbsp;45,000 Pts.</p><div>Club Example &amp; Spa<br>100 Example Road</div><p>&#8594; &#x2192;</p></body></html>`;
    expect(htmlText(html)).toBe("Check-In 4:00 p.m.\nCheckout 10:00 a.m.\nTotal for Stay 45,000 Pts.\nClub Example & Spa\n100 Example Road\n→ →");
    expect(htmlText(null)).toBeNull();
  });
});

describe("an email forwarded as an attachment, and markup listing a flight once per passenger (docs/trips.md §27)", () => {
  it("reads the attached original, markup and all; one flight however many passengers", async () => {
    const { readMessage, attachedMessage } = await import("../src/kos/mime");
    const ld = JSON.stringify([1, 2, 3].map(() => ({ "@context": "http://schema.org", "@type": "FlightReservation", reservationNumber: "QZ7XKM",
      reservationFor: { "@type": "Flight", flightNumber: "1234", airline: { "@type": "Airline", iataCode: "UA" }, departureAirport: { "@type": "Airport", iataCode: "DEN" },
        arrivalAirport: { "@type": "Airport", iataCode: "ORD" }, departureTime: "2027-04-05T06:00:00-06:00", arrivalTime: "2027-04-05T08:15:00-05:00" } })));
    const inner = `From: Example Air <a@example.com>\r\nSubject: Your flight\r\nDate: Mon, 1 Feb 2027 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><script type="application/ld+json">${ld}</script><body>Your flight</body></html>\r\n`;
    const outer = `From: me@example.com\r\nSubject: Fwd: Your flight\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n--b1\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="Your flight.eml"\r\n\r\n${inner}--b1--\r\n`;
    const m = attachedMessage(outer);
    expect(m?.subject).toBe("Your flight");
    const b = reservations(m!.html);
    expect(b).toHaveLength(1);                                                // three passengers, one flight
    expect(b[0]).toMatchObject({ kind: "flight", confirmation: "QZ7XKM", flight: { airline: "UA", number: "1234", from: "DEN", to: "ORD" } });
    expect(attachedMessage(inner)).toBeNull();
  });
});

