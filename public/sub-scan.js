// SUB's screenshot reader (docs/sub.md §2a). Loads Tesseract.js from public/vendor/tesseract/ only
// once a screenshot is picked, reads the text on this device, and hands it back to SUB through
// sessionStorage ("minty.sub.scan", set by SUB with the form's draft before it came here), with the
// screenshot's SHA-256 so the same file is recognised later. Nothing is uploaded.
(function () {
  // ?for=jet: JET's "add a booking" sent us here (docs/trips.md §2.4); otherwise SUB did
  const FOR_JET = new URLSearchParams(location.search).get("for") === "jet";
  const KEY = FOR_JET ? "minty.jet.scan" : "minty.sub.scan", BACK = FOR_JET ? "/jet/#/add" : "/?sub", V = "/vendor/tesseract/";
  document.getElementById("back").href = BACK;
  if (FOR_JET) document.querySelector("h1").textContent = "Read a booking's screenshot";
  const $ = id => document.getElementById(id);
  const status = t => { $("status").textContent = t; };
  let sha = null, lib = null;

  const load = () => lib ??= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `${V}tesseract.min.js`; s.onload = () => ok(window.Tesseract); s.onerror = () => fail(new Error("Couldn't load the reader"));
    document.head.append(s);
  });

  $("shot").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    $("use").hidden = true;
    try {
      const buf = await file.arrayBuffer();
      sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
      const url = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); });
      Object.assign($("preview"), { src: url, hidden: false });
      status("Loading the reader (about 7 MB, the first time only)…");
      const T = await load();
      const worker = await T.createWorker("eng", 1, {
        workerPath: `${V}worker.min.js`, corePath: `${V}tesseract-core-simd-lstm.wasm.js`, langPath: V.slice(0, -1), workerBlobURL: false, gzip: true,
        logger: m => { if (m.status === "recognizing text") status(`Reading… ${Math.round(m.progress * 100)}%`); },
      });
      const { data } = await worker.recognize(file);
      await worker.terminate();
      Object.assign($("text"), { value: data.text.trim(), hidden: false });
      $("use").hidden = false;
      status(data.text.trim() ? "Read. Check the text, correct anything misread, then use it." : "No text found in this image.");
    } catch (x) {
      status(`Couldn't read this image: ${x.message}. You can paste the text into SUB instead.`);
    }
  });

  $("use").addEventListener("click", () => {
    let scan = {};
    try { scan = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") ?? {}; } catch { /* no draft: a new offer */ }
    const text = $("text").value.trim();
    try { sessionStorage.setItem(KEY, JSON.stringify({ offer: scan.offer ?? "new", draft: scan.draft ?? null, text, sha })); }
    catch { status("This browser won't hand the text back (private window?): copy it and paste it into SUB."); return; }
    location.href = BACK;
  });
})();
