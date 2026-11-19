// JET T0 (docs/trips.md §2.1): can a Google Apps Script reach Minty through Cloudflare Access, with
// only read-only Gmail access? Paste this file and appsscript.json into a new project at
// script.google.com, signed in as the Gmail account made for Minty. Fill in the three values below
// IN THE SCRIPT EDITOR ONLY (never commit them), then Run → spike, allow it, and read the log
// (View → Logs). Paste the log back to Claude; it contains no keys.
const MINTY_URL = "https://minty.example.workers.dev";   // your Minty address
const ACCESS_CLIENT_ID = "";                             // the service token's Client ID
const ACCESS_CLIENT_SECRET = "";                         // and its secret

function spike() {
  const r = UrlFetchApp.fetch(MINTY_URL + "/healthz", {
    headers: { "CF-Access-Client-Id": ACCESS_CLIENT_ID, "CF-Access-Client-Secret": ACCESS_CLIENT_SECRET },
    followRedirects: false, muteHttpExceptions: true,
  });
  const body = r.getContentText().slice(0, 80);
  Logger.log("Minty: HTTP " + r.getResponseCode() + (body.indexOf('"ok":true') >= 0 ? ", Minty answered" : ", body starts: " + body.replace(/\s+/g, " ")));
  // read-only Gmail: how many messages each label has (none are read or changed)
  ["Minty/Trips", "Minty/Bills"].forEach(function (name) {
    const label = GmailApp.getUserLabelByName(name);
    Logger.log(name + ": " + (label ? label.getThreads(0, 100).length + " thread(s)" : "no such label yet"));
  });
}
