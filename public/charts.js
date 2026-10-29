// Small SVG charts: grouped bars, lines and a legend for CFA's and EGG's popups, and the
// interactive pieces below (area chart, donut, stat card) for the dashboard, CFA and EGG. No library and no CDN, so the CSP stays 'self'. Colours come from CSS classes on each
// series (cfa.css), so light and dark follow the dashboard's tokens. Each chart returns an SVG
// string; values in a <title> show on hover. Loaded as a classic script: window.MintyCharts.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PAD = { l: 52, r: 8, t: 10, b: 24 };    // drawn at the container's width (`width`), so text stays its CSS size

  /** Round gridline steps: 0, then 1, 2 or 5 × a power of ten. */
  function ticks(lo, hi, n = 4) {
    if (lo === hi) hi = lo + 1;
    const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw);
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function frame(labels, values, h, fmt, W, gap = 48) {
    const all = values.flat().filter(v => Number.isFinite(v));
    const t = ticks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = t[0], hi = t[t.length - 1];
    const y = v => PAD.t + (h - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo || 1));
    const every = Math.ceil(labels.length / Math.max(2, Math.floor((W - PAD.l) / gap)));   // a label every `gap` px at most
    const grid = t.map(v => `<line class="ch-grid${v === 0 ? " zero" : ""}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="ch-axis" x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join("");
    return { y, grid, every };
  }

  /** Grouped bars: one group per label, one bar per series. */
  function bars({ labels, series, width = 640, height = 200, fmt = String, short = l => l }) {
    const W = width, { y, grid, every } = frame(labels, series.map(s => s.values), height, fmt, W);
    const slot = (W - PAD.l - PAD.r) / labels.length, gap = Math.min(10, slot * 0.25), bw = (slot - gap) / series.length;
    let body = "";
    labels.forEach((l, i) => {
      series.forEach((s, j) => {
        const v = s.values[i];
        if (!Number.isFinite(v)) return;
        const x = PAD.l + i * slot + gap / 2 + j * bw, top = Math.min(y(v), y(0)), hgt = Math.abs(y(v) - y(0));
        body += `<rect class="ch-bar ${esc(s.cls)}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0.5, hgt).toFixed(1)}"><title>${esc(`${l} · ${s.name}: ${fmt(v)}`)}</title></rect>`;
      });
      if (i % every === 0) body += `<text class="ch-axis" x="${(PAD.l + i * slot + slot / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(short(l))}</text>`;
    });
    return `<svg class="ch" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img">${grid}${body}</svg>`;
  }

  /** Lines over evenly spaced labels; null values leave a gap. */
  function lines({ labels, series, width = 640, height = 180, fmt = String, short = l => l, dots = false, gap = 48 }) {
    const W = width, { y, grid, every } = frame(labels, series.map(s => s.values), height, fmt, W, gap);
    const n = labels.length, x = i => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
    let body = "";
    for (const s of series) {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
      });
      body += `<path class="ch-line ${esc(s.cls)}" d="${d}"/>`;
      s.values.forEach((v, i) => {
        if (Number.isFinite(v) && (dots || n === 1 || i === n - 1)) body += `<circle class="ch-dot ${esc(s.cls)}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${esc(`${labels[i]} · ${s.name}: ${fmt(v)}`)}</title></circle>`;
      });
    }
    // every `every`-th label, and the last one unless it would sit on top of the one before
    labels.forEach((l, i) => { if ((i % every === 0 && (i === 0 || n - 1 - i >= every * 0.8)) || i === n - 1) body += `<text class="ch-axis" x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(short(l))}</text>`; });
    return `<svg class="ch" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img">${grid}${body}</svg>`;
  }

  const legend = series => `<div class="ch-legend">${series.map(s => `<span><i class="${esc(s.cls)}"></i>${esc(s.name)}</span>`).join("")}</div>`;

  // --- Interactive pieces: the dashboard's cards, chart and donut, and CFA's and EGG's cards -----
  // Plain-JS takes on EasyUI's Interactive area chart, Donut chart and Stat card designs
  // (github.com/Surajmaurya1/easyui, MIT), written for Minty: no React, no animation library.
  // Movement is transform/attribute changes in requestAnimationFrame; reduced motion skips it.
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeOut = t => 1 - (1 - t) ** 4;
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const f1 = v => v.toFixed(1);
  let uid = 0;
  /** Runs step(eased 0→1) for `ms`; returns a cancel. */
  function tween(ms, step, ease = easeOut) {
    if (reduced() || ms <= 0) { step(1); return () => {}; }
    let raf, t0;
    const go = now => { t0 ??= now; const p = Math.min(1, (now - t0) / ms); step(ease(p)); if (p < 1) raf = requestAnimationFrame(go); };
    raf = requestAnimationFrame(go);
    return () => cancelAnimationFrame(raf);
  }
  /** Catmull-Rom through v at a fractional index. */
  function spline(v, pos) {
    const n = v.length;
    if (n === 1) return v[0];
    const i = Math.min(Math.floor(pos), n - 2), t = pos - i;
    const p0 = v[Math.max(i - 1, 0)], p1 = v[i], p2 = v[i + 1], p3 = v[Math.min(i + 2, n - 1)];
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  /** A monotone curve (no overshoot) through [x, y] points: the sparklines and the area chart. */
  function monotone(pts) {
    const n = pts.length;
    if (n === 2) return `M${f1(pts[0][0])},${f1(pts[0][1])}L${f1(pts[1][0])},${f1(pts[1][1])}`;
    const dx = [], s = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; s[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    m[0] = s[0]; m[n - 1] = s[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
    let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${f1(pts[i][0] + h)},${f1(pts[i][1] + m[i] * h)} ${f1(pts[i + 1][0] - h)},${f1(pts[i + 1][1] - m[i + 1] * h)} ${f1(pts[i + 1][0])},${f1(pts[i + 1][1])}`;
    }
    return d;
  }
  /** A segmented control's sliding thumb, under its pressed button; returns a re-place. */
  function segpill(group) {
    let thumb = group.querySelector(".seg-thumb");
    if (!thumb) { thumb = document.createElement("i"); thumb.className = "seg-thumb"; group.prepend(thumb); }
    const place = () => {
      const b = group.querySelector('[aria-pressed="true"]');
      thumb.style.opacity = b ? 1 : 0;
      if (b) { thumb.style.width = `${b.offsetWidth}px`; thumb.style.transform = `translateX(${b.offsetLeft}px)`; }
    };
    place();
    return place;
  }
  function deltaHtml(delta, good, text) {
    if (delta === null || delta === undefined || !Number.isFinite(delta)) return "";
    const flat = Math.abs(delta) < 0.0005, cls = flat ? "flat" : good ? "good" : "bad";
    const t = text ?? `${Math.abs(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}%`;
    return `<span class="delta ${cls}"><svg viewBox="0 0 10 9" width="8" height="8" aria-hidden="true"${delta < 0 ? ' style="transform:rotate(180deg)"' : ""}><path d="M5 1.5 9 7.5H1Z" fill="currentColor"/></svg>${esc(t)}</span>`;
  }
  const isGood = (delta, goodWhen) => (goodWhen === "down" ? delta < 0 : delta > 0);

  /** An interactive area chart: range buttons that morph the line, and a scrubbing tooltip.
   *  o: { title, ranges: [{ key, label, points: [{ label, axis, value }] }], range, fmt, fmtAxis,
   *       head(i | null, range) → { value, delta, good, deltaText, caption }, onPoint(i | null, range), onRange(range), height } */
  function area(el, o) {
    const id = `ia${++uid}`, H = o.height ?? 230, P = { t: 14, r: 10, b: 24, l: 46 }, N = 72;
    const fmtAxis = o.fmtAxis ?? o.fmt;
    el.classList.add("ia");
    el.innerHTML = `<div class="ia-head"><div class="ia-title">${esc(o.title)}</div><div class="ia-value num"></div><div class="ia-sub"></div></div>
      <div class="ia-plot"><svg class="ia-svg" height="${H}" tabindex="0" role="img" aria-label="${esc(o.title)}: use the arrow keys to read each point">
        <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".2"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>
        <clipPath id="${id}c"><rect x="0" y="0" height="${H}" width="0"/></clipPath></defs>
        <g class="ia-grid"></g><g clip-path="url(#${id}c)"><path class="ia-area" fill="url(#${id}g)"/><path class="ia-line"/></g>
        <line class="ia-cross" y1="${P.t - 6}" y2="${H - P.b}" visibility="hidden"/><circle class="ia-dot" r="4.5" visibility="hidden"/>
        <rect class="ia-hit" x="0" y="0" height="${H}" fill="transparent"/></svg><div class="ia-tip" hidden></div></div>
      <div class="segpill ia-ranges" role="group" aria-label="How far back">${o.ranges.map(r => `<button type="button" data-r="${esc(r.key)}" aria-pressed="${r.key === o.range}">${esc(r.label)}</button>`).join("")}</div>`;
    const $ = s => el.querySelector(s), svg = $(".ia-svg"), clip = $(`#${id}c rect`), tip = $(".ia-tip");
    let W = 0, cur = o.range, drawn = null, stop = () => {}, hover = null;
    const prep = r => {
      const vals = r.points.map(p => p.value);
      const t = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
      const lo = t[0], hi = t[t.length - 1];
      return { ...r, t, lo, hi, ny: Array.from({ length: N }, (_, k) => Math.max(0, (spline(vals, (k / (N - 1)) * (vals.length - 1)) - lo) / (hi - lo || 1))) };
    };
    let R = Object.fromEntries(o.ranges.map(r => [r.key, prep(r)]));
    const X = k => P.l + (k / (N - 1)) * (W - P.l - P.r), Y = ny => P.t + (1 - ny) * (H - P.t - P.b);
    const xi = (i, n) => P.l + (n === 1 ? (W - P.l - P.r) / 2 : (i / (n - 1)) * (W - P.l - P.r));
    function paths() {
      const pts = drawn.map((ny, k) => [X(k), Y(ny)]);
      const d = monotone(pts);                 // never past a point's value: a spiky month of days stays above $0
      $(".ia-line").setAttribute("d", d);
      $(".ia-area").setAttribute("d", `${d}L${f1(X(N - 1))},${H - P.b}L${P.l},${H - P.b}Z`);
    }
    function grid() {
      const r = R[cur], n = r.points.length, count = W < 380 ? 3 : W < 520 ? 4 : 5;
      const yv = v => P.t + (1 - (v - r.lo) / (r.hi - r.lo || 1)) * (H - P.t - P.b);
      let g = r.t.map(v => `<line class="ia-gl" x1="${P.l}" x2="${W - P.r}" y1="${f1(yv(v))}" y2="${f1(yv(v))}"/><text class="ch-axis" x="${P.l - 8}" y="${f1(yv(v) + 4)}" text-anchor="end">${esc(fmtAxis(v))}</text>`).join("");
      const idx = n <= count ? [...Array(n).keys()] : Array.from({ length: count }, (_, j) => Math.round((j * (n - 1)) / (count - 1)));
      g += idx.map((i, j) => `<text class="ch-axis" x="${f1(xi(i, n))}" y="${H - 6}" text-anchor="${j === 0 && idx.length > 1 ? "start" : j === idx.length - 1 && idx.length > 1 ? "end" : "middle"}">${esc(r.points[i].axis ?? r.points[i].label)}</text>`).join("");
      const gEl = $(".ia-grid");
      gEl.innerHTML = g;
      gEl.classList.remove("in"); void gEl.getBoundingClientRect(); gEl.classList.add("in");
    }
    function head(i) {
      const h = o.head(i, cur) ?? {};
      $(".ia-value").textContent = h.value === undefined ? "" : o.fmt(h.value);
      $(".ia-sub").innerHTML = deltaHtml(h.delta, h.good, h.deltaText) + `<span class="ia-cap">${esc(h.caption ?? "")}</span>`;
    }
    function show(i) {
      const r = R[cur], n = r.points.length;
      if (i === null) {
        hover = null;
        for (const s of [".ia-cross", ".ia-dot"]) $(s).setAttribute("visibility", "hidden");
        tip.hidden = true; head(null); o.onPoint?.(null, cur);
        return;
      }
      hover = i = Math.max(0, Math.min(n - 1, i));
      const cx = xi(i, n), k = n === 1 ? 0 : (i / (n - 1)) * (N - 1), a = Math.floor(k), b = Math.min(N - 1, a + 1);
      const cy = Y(drawn[a] + (drawn[b] - drawn[a]) * (k - a));
      const cross = $(".ia-cross"), dot = $(".ia-dot");
      cross.setAttribute("x1", f1(cx)); cross.setAttribute("x2", f1(cx)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", f1(cx)); dot.setAttribute("cy", f1(cy)); dot.setAttribute("visibility", "visible");
      const p = r.points[i];
      tip.innerHTML = `<span>${esc(p.label)}</span><b class="num">${esc(o.fmt(p.value))}</b>`;
      tip.hidden = false;
      tip.style.transform = `translateX(${f1(Math.max(0, Math.min(W - 124, cx - 62)))}px)`;
      head(i); o.onPoint?.(i, cur);
    }
    function size() {
      const w = Math.round(el.clientWidth);
      if (!w || w === W) return;
      W = w;
      svg.setAttribute("width", W); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); $(".ia-hit").setAttribute("width", W);
      if (drawn) { paths(); grid(); clip.setAttribute("width", W); if (hover !== null) show(hover); }
    }
    function setRange(key) {
      if (!R[key]) return;
      cur = key;
      el.querySelectorAll(".ia-ranges button").forEach(b => b.setAttribute("aria-pressed", b.dataset.r === key));
      placeThumb();
      const from = drawn.slice(), to = R[key].ny;
      stop();
      stop = tween(550, t => { for (let k = 0; k < N; k++) drawn[k] = from[k] + (to[k] - from[k]) * t; paths(); }, easeInOut);
      grid(); show(null);
      o.onRange?.(key);
    }
    size();
    if (!W) { W = 320; svg.setAttribute("width", W); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); $(".ia-hit").setAttribute("width", W); }
    drawn = R[cur].ny.slice(); paths(); grid(); head(null);
    const placeThumb = segpill($(".ia-ranges"));
    tween(1100, t => clip.setAttribute("width", f1(t * W)), easeInOut);
    el.querySelector(".ia-ranges").addEventListener("click", e => { const b = e.target.closest("[data-r]"); if (b) setRange(b.dataset.r); });
    const at = e => {
      const box = svg.getBoundingClientRect(), n = R[cur].points.length;
      return n === 1 ? 0 : Math.round(((e.clientX - box.left - P.l) / (W - P.l - P.r)) * (n - 1));
    };
    const hit = $(".ia-hit");
    hit.addEventListener("pointermove", e => show(at(e)));
    hit.addEventListener("pointerdown", e => show(at(e)));
    hit.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") show(null); });
    svg.addEventListener("keydown", e => {
      const n = R[cur].points.length;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show(hover === null ? n - 1 : hover + (e.key === "ArrowLeft" ? -1 : 1)); }
      if (e.key === "Escape") show(null);
    });
    svg.addEventListener("blur", () => show(null));
    new ResizeObserver(size).observe(el);
    return {
      setRange, clear: () => show(null),
      update(ranges) { R = Object.fromEntries(ranges.map(r => [r.key, prep(r)])); if (!R[cur]) cur = ranges[0].key; drawn = drawn ?? R[cur].ny.slice(); setRange(cur); },
    };
  }

  /** A donut: segments by value, the hovered (or picked) one named in the middle, and a legend.
   *  A tap on a slice or a legend row picks it (onSelect(key), or null to let go: the caller lists
   *  its transactions); the ⊘ on a row hides it from the ring.
   *  o: { segments: [{ key, label, value, color }], title, fmt, size, thickness, onSelect } */
  function donut(el, o) {
    const TH = o.thickness ?? 14;
    const hidden = new Set();
    let segs = [], title = o.title, hover = null, sel = null, intro = true, stop = () => {};
    el.classList.add("dn");
    el.innerHTML = `<div class="dn-ring"><svg class="dn-svg" role="img"></svg><div class="dn-center"><span class="dn-lab"></span><b class="dn-val num"></b><span class="dn-pct"></span></div></div><div class="dn-legend"></div>`;
    const svg = el.querySelector(".dn-svg"), legend = el.querySelector(".dn-legend");
    const D = () => Math.max(120, Math.min(o.size ?? 176, el.clientWidth || 176));
    const shown = () => segs.filter(s => !hidden.has(s.key) && s.value > 0);
    const total = () => shown().reduce((t, s) => t + s.value, 0);
    const focus = () => hover ?? sel;
    function center() {
      const s = segs.find(x => x.key === focus() && !hidden.has(x.key)), t = total();
      el.querySelector(".dn-lab").textContent = s ? s.label : title;
      el.querySelector(".dn-val").textContent = o.fmt(s ? s.value : t);
      el.querySelector(".dn-pct").textContent = s && t ? `${Math.round((s.value / t) * 100)}% of the total` : "";
      el.querySelector(".dn-center").classList.toggle("on", !!s);
    }
    function arcs(progress = () => 1) {
      const d = D(), c = d / 2, r = c - (TH + 6) / 2 - 1, t = total(), list = shown();
      const pad = list.length > 1 ? 3.5 / r + TH / 2 / r : 0;
      const pt = a => `${f1(c + r * Math.sin(a))} ${f1(c - r * Math.cos(a))}`;
      let a = 0, out = `<circle class="dn-track" cx="${c}" cy="${c}" r="${f1(r)}" stroke-width="${TH}"/>`;
      list.forEach((s, i) => {
        const span = (s.value / (t || 1)) * Math.PI * 2;
        let a0 = a + pad, a1 = a + span - pad;
        a += span;
        if (a1 <= a0) return;
        a1 = a0 + (a1 - a0) * progress(i);
        const on = s.key === focus(), w = on ? TH + 4 : TH;
        const path = list.length === 1 && progress(i) >= 1
          ? `M${c} ${f1(c - r)}A${f1(r)} ${f1(r)} 0 1 1 ${f1(c - 0.01)} ${f1(c - r)}`
          : `M${pt(a0)}A${f1(r)} ${f1(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)}`;
        out += `<path class="dn-arc${on ? " on" : ""}" d="${path}" stroke="${esc(s.color)}" style="stroke-width:${w}px" data-k="${esc(s.key)}"/>` +
               `<path class="dn-hit" d="${path}" data-k="${esc(s.key)}"><title>${esc(`${s.label}: ${o.fmt(s.value)}`)}</title></path>`;
      });
      svg.setAttribute("width", d); svg.setAttribute("height", d); svg.setAttribute("viewBox", `0 0 ${d} ${d}`);
      svg.innerHTML = out;
      svg.classList.toggle("hl", focus() !== null && !hidden.has(focus()));
    }
    function rows() {
      const t = total();
      legend.innerHTML = segs.map(s => {
        const off = hidden.has(s.key);
        return `<div class="dn-row${off ? " off" : ""}${s.key === focus() ? " on" : ""}${s.key === sel ? " sel" : ""}" data-k="${esc(s.key)}">
          <button type="button" class="dn-pick" aria-pressed="${s.key === sel}"${off ? " disabled" : ""} title="${o.onSelect ? `List ${esc(s.label)}'s transactions` : esc(s.label)}">
            <i style="background:${esc(s.color)}"></i><span class="dn-name">${esc(s.label)}</span>
            <span class="dn-v num">${off ? "—" : esc(o.fmt(s.value))}</span><span class="dn-p num">${off || !t ? "" : `${Math.round((s.value / t) * 100)}%`}</span></button>
          <button type="button" class="dn-eye" data-hide aria-pressed="${off}" aria-label="${off ? "Show" : "Hide"} ${esc(s.label)}" title="${off ? "Show" : "Hide"} it in the ring">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/>${off ? "" : `<path d="M4.2 11.8 11.8 4.2" stroke="currentColor" stroke-width="1.4"/>`}</svg></button></div>`;
      }).join("");
    }
    function draw() {
      stop();
      if (intro && !reduced()) {
        intro = false;
        const n = shown().length, dur = 900, start = performance.now();
        let raf;
        const step = now => {
          const ms = now - start;
          arcs(i => easeOut(Math.max(0, Math.min(1, (ms - 120 - i * 90) / dur))));
          if (ms < 120 + n * 90 + dur) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        stop = () => cancelAnimationFrame(raf);
        const target = total(), valEl = el.querySelector(".dn-val");
        center();
        tween(800, k => { if (focus() === null) valEl.textContent = o.fmt(target * k); });
      } else { intro = false; arcs(); center(); }
      rows();
    }
    const repaint = () => { arcs(); center(); rows(); };
    const setHover = k => { if (hover === k) return; hover = k; repaint(); };
    const pick = k => { sel = k === sel ? null : k; hover = null; repaint(); o.onSelect?.(sel); };
    svg.addEventListener("pointerover", e => { const k = e.target.closest(".dn-hit")?.dataset.k; if (k && e.pointerType === "mouse") setHover(k); });
    svg.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") setHover(null); });
    svg.addEventListener("click", e => { const k = e.target.closest(".dn-hit")?.dataset.k; if (k) pick(k); });
    legend.addEventListener("pointerover", e => { const k = e.target.closest(".dn-row")?.dataset.k; if (k && e.pointerType === "mouse" && !hidden.has(k)) setHover(k); });
    legend.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") setHover(null); });
    legend.addEventListener("click", e => {
      const row = e.target.closest(".dn-row");
      if (!row) return;
      const k = row.dataset.k;
      if (e.target.closest("[data-hide]")) {
        if (hidden.has(k)) hidden.delete(k);
        else if (shown().length > 1) hidden.add(k);            // the last one stays
        if (hidden.has(sel)) { sel = null; o.onSelect?.(null); }
        hover = null; repaint();
        legend.querySelector(`.dn-row[data-k="${CSS.escape(k)}"] [data-hide]`)?.focus();
        return;
      }
      pick(k);
      legend.querySelector(`.dn-row[data-k="${CSS.escape(k)}"] .dn-pick`)?.focus();
    });
    return {
      update(segments, t) {
        segs = segments; title = t ?? title;
        for (const k of [...hidden]) if (!segs.some(s => s.key === k)) hidden.delete(k);
        if (hover !== null && !segs.some(s => s.key === hover)) hover = null;
        if (sel !== null && !segs.some(s => s.key === sel)) { sel = null; o.onSelect?.(null); }
        draw();
      },
      selected: () => sel,
    };
  }

  /** A stat card's HTML: label, a change pill, the number, a caption and a sparkline. wire() then
   *  makes the number count up and the sparkline scrub (pointer, or the arrow keys).
   *  o: { label, value, fmt, delta, goodWhen: "up" | "down", deltaText, caption, trend: [numbers],
   *       labels: [strings], dot (a colour), tag, attrs, cls, countUp, touch (scrub by touch too) } */
  const STATS = new Map();
  function stat(o) {
    const id = `sc${++uid}`, tag = o.tag ?? "div";
    STATS.set(id, o);
    let spark = "";
    const v = o.trend ?? [];
    if (v.length >= 2) {
      const lo = Math.min(...v), hi = Math.max(...v), Hs = 44;
      const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 6 + (1 - (x - lo) / (hi - lo || 1)) * (Hs - 12)]);
      const d = monotone(pts), last = pts.at(-1);
      spark = `<div class="sc-spark" style="--h:${Hs}px"><svg viewBox="0 0 100 ${Hs}" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
        <path class="sc-area" d="${d}L100,${Hs}L0,${Hs}Z" fill="url(#${id}g)"/><path class="sc-line" d="${d}" vector-effect="non-scaling-stroke"/></svg>
        <i class="sc-last" style="left:${f1(last[0])}%;top:${f1((last[1] / Hs) * 100)}%"></i><i class="sc-cur" hidden></i><i class="sc-pt" hidden></i></div>`;
      o._pts = pts.map(([x, y]) => [x, (y / Hs) * 100]);
    }
    const good = o.delta !== null && o.delta !== undefined && isGood(o.delta, o.goodWhen ?? "up");
    return `<${tag} class="sc${o.cls ? ` ${esc(o.cls)}` : ""}" data-sc="${id}"${o.attrs ? ` ${o.attrs}` : ""}${tag === "div" && v.length >= 2 ? ' tabindex="0"' : ""}>
      <span class="sc-top"><span class="sc-label">${o.dot ? `<i class="sc-dot" style="background:${esc(o.dot)}"></i>` : ""}${esc(o.label)}</span>${deltaHtml(o.delta, good, o.deltaText)}</span>
      <span class="sc-value num">${esc(o.fmt(o.value))}</span>
      <span class="sc-cap">${esc(o.caption ?? "")}</span>${spark}</${tag}>`;
  }
  function wire(root) {
    for (const card of root.querySelectorAll("[data-sc]")) {
      const o = STATS.get(card.dataset.sc);
      STATS.delete(card.dataset.sc);
      if (!o) continue;
      const valEl = card.querySelector(".sc-value"), capEl = card.querySelector(".sc-cap");
      if (o.countUp !== false && Number.isFinite(o.value)) tween(1100, k => { valEl.textContent = o.fmt(o.value * k); });
      const sp = card.querySelector(".sc-spark");
      if (!sp) continue;
      const cur = sp.querySelector(".sc-cur"), pt = sp.querySelector(".sc-pt"), n = o.trend.length;
      let at = null;
      const show = i => {
        if (i === null) { at = null; cur.hidden = pt.hidden = true; valEl.textContent = o.fmt(o.value); capEl.textContent = o.caption ?? ""; card.classList.remove("scrub"); return; }
        at = i = Math.max(0, Math.min(n - 1, i));
        const [x, y] = o._pts[i];
        cur.hidden = pt.hidden = false;
        cur.style.left = pt.style.left = `${f1(x)}%`;
        pt.style.top = `${f1(y)}%`;
        valEl.textContent = o.fmt(o.trend[i]);
        capEl.textContent = o.labels?.[i] ?? "";
        card.classList.add("scrub");
      };
      const idx = e => { const b = sp.getBoundingClientRect(); return Math.round(((e.clientX - b.left) / b.width) * (n - 1)); };
      card.addEventListener("pointermove", e => { if (e.pointerType !== "touch" || o.touch) show(idx(e)); });
      card.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") show(null); });
      if (o.touch) { sp.style.touchAction = "pan-y"; card.addEventListener("pointerdown", e => { if (e.pointerType === "touch") show(idx(e)); }); }
      card.addEventListener("keydown", e => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show(at === null ? n - 1 : at + (e.key === "ArrowLeft" ? -1 : 1)); }
        if (e.key === "Escape") show(null);
      });
      card.addEventListener("blur", () => show(null));
    }
  }
  /** A range calendar (the Dates menu): a month at a time, sliding between months; the first tap
   *  picks the start and the band follows the pointer, the second sets the end. Arrow keys move a
   *  day or a week, Page Up/Down a month, Home/End to the week's ends. After EasyUI's Calendar (MIT).
   *  o: { from, to, max, onChange(from, to) } (dates as YYYY-MM-DD). Returns { set(from, to) }. */
  function calendar(el, o) {
    const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
    const ymd = s => [Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))];
    const add = (s, n) => { const [y, m, d] = ymd(s); return iso(y, m, d + n); };
    const now = new Date(), today = iso(now.getFullYear(), now.getMonth(), now.getDate());
    const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
    const LONG = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    const WD = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + i))));
    const at = s => new Date(`${s}T12:00:00Z`);
    let from = o.from || "", to = o.to || "", hover = "", focus = to || from || today, view = focus.slice(0, 7);
    el.classList.add("cal2");
    function render(dir = 0) {
      const [y, m] = ymd(`${view}-01`);
      const first = new Date(Date.UTC(y, m, 1)).getUTCDay(), dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      if (focus.slice(0, 7) !== view) focus = iso(y, m, Math.min(Number(focus.slice(8, 10)), dim));
      let cells = "";
      for (let i = 0; i < Math.ceil((first + dim) / 7) * 7; i++) {
        const d = i - first + 1;
        if (d < 1 || d > dim) { cells += `<span class="c2-pad" role="gridcell"></span>`; continue; }
        const s = iso(y, m, d), off = o.max && s > o.max;
        cells += `<button type="button" class="c2-day${s === today ? " today" : ""}" role="gridcell" data-d="${s}" data-col="${i % 7}" data-last="${d === dim ? 1 : 0}"
          tabindex="${s === focus ? 0 : -1}"${off ? " disabled" : ""} aria-label="${esc(LONG.format(at(s)))}"><span>${d}</span></button>`;
      }
      const slide = dir ? (dir < 0 ? "from-l" : "from-r") : "";
      if (!el.querySelector(".c2-grid")) {                 // built once: a click on an arrow keeps its button (and the menu open)
        el.innerHTML = `<div class="c2-head">
            <button type="button" class="c2-nav" data-nav="-1" aria-label="Previous month"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <div class="c2-title" aria-live="polite"><span class="c2-m"></span></div>
            <button type="button" class="c2-nav" data-nav="1" aria-label="Next month"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
          <div class="c2-wd" aria-hidden="true">${WD.map(w => `<span>${esc(w)}</span>`).join("")}</div>
          <div class="c2-grid" role="grid"></div>
          <div class="c2-sum" role="status"></div>`;
      }
      const title = el.querySelector(".c2-m"), grid = el.querySelector(".c2-grid"), label = MONTH.format(at(`${view}-15`));
      title.textContent = label;
      grid.setAttribute("aria-label", label);
      grid.innerHTML = cells;
      el.querySelector('[data-nav="1"]').disabled = !!(o.max && view >= o.max.slice(0, 7));
      for (const x of [title, grid]) { x.classList.remove("from-l", "from-r"); if (slide) { void x.offsetWidth; x.classList.add(slide); } }
      paint();
    }
    function paint() {
      const end = to || (from && hover && hover >= from ? hover : "");
      for (const b of el.querySelectorAll(".c2-day")) {
        const s = b.dataset.d, inside = from && end && s >= from && s <= end && from !== end;
        b.classList.toggle("end", s === from || s === end);
        b.classList.toggle("in", !!inside);
        b.classList.toggle("cap-l", !!inside && (s === from || b.dataset.col === "0" || s.endsWith("-01")));
        b.classList.toggle("cap-r", !!inside && (s === end || b.dataset.col === "6" || b.dataset.last === "1"));
        b.setAttribute("aria-pressed", s === from || s === to);
      }
      const n = from && end ? Math.round((Date.parse(end) - Date.parse(from)) / 864e5) + 1 : 0;
      el.querySelector(".c2-sum").textContent = !from ? "Pick the first day" : !to ? `From ${SHORT.format(at(from))}: now pick the last day`
        : `${SHORT.format(at(from))} – ${SHORT.format(at(to))} · ${n} day${n === 1 ? "" : "s"}`;
    }
    const go = (s, focusIt = true) => {
      if (o.max && s > o.max) s = o.max;
      const dir = s.slice(0, 7) < view ? -1 : s.slice(0, 7) > view ? 1 : 0;
      focus = s;
      if (dir) { view = s.slice(0, 7); render(dir); }
      else for (const b of el.querySelectorAll(".c2-day")) b.tabIndex = b.dataset.d === s ? 0 : -1;
      if (focusIt) el.querySelector(`.c2-day[data-d="${s}"]`)?.focus();
    };
    el.addEventListener("click", e => {
      const nav = e.target.closest("[data-nav]");
      if (nav) { const [y, m] = ymd(`${view}-01`); view = iso(y, m + Number(nav.dataset.nav), 1).slice(0, 7); render(Number(nav.dataset.nav)); return; }
      const b = e.target.closest(".c2-day");
      if (!b || b.disabled) return;
      const s = b.dataset.d;
      if (!from || to || s < from) { from = s; to = ""; }       // a new range starts (or an earlier start)
      else { to = s; o.onChange?.(from, to); }
      hover = ""; focus = s; paint();
    });
    el.addEventListener("pointerover", e => {
      const b = e.target.closest(".c2-day");
      if (!b || !from || to || b.dataset.d === hover) return;
      hover = b.dataset.d; paint();
    });
    el.addEventListener("pointerleave", () => { if (hover) { hover = ""; paint(); } });
    el.addEventListener("keydown", e => {
      const b = e.target.closest(".c2-day");
      if (!b) return;
      const s = b.dataset.d, [y, m, d] = ymd(s), wd = Number(b.dataset.col);
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      let next = step ? add(s, step) : e.key === "Home" ? add(s, -wd) : e.key === "End" ? add(s, 6 - wd)
        : e.key === "PageUp" || e.key === "PageDown" ? iso(y, m + (e.key === "PageUp" ? -1 : 1), Math.min(d, new Date(Date.UTC(y, m + (e.key === "PageUp" ? 0 : 2), 0)).getUTCDate())) : null;
      if (!next) return;
      e.preventDefault();
      go(next);
      if (from && !to) { hover = focus; paint(); }
    });
    render();
    return {
      set(f, t) {
        from = f || ""; to = t || ""; hover = "";
        const want = (to || from || today).slice(0, 7);
        focus = to || from || today;
        if (want !== view) { view = want; render(); } else paint();
      },
    };
  }

  /** A bar chart, grouped (side by side) or stacked, after EasyUI's Bar chart (MIT): rounded tops,
   *  a band over the group under the pointer (the others dim) with a tooltip of its bars, a legend
   *  that turns a series off, and bars that grow in one after another.
   *  o: { groups: [{ key, label }], series: [{ key, label, color }], value(group, series) → number,
   *       fmt, fmtAxis, variant: "grouped" | "stacked", height, animate } */
  function barchart(el, o) {
    const H = o.height ?? 220, M = { t: 12, r: 8, b: 26, l: 50 }, off = new Set(o.off ?? []);
    const fmtAxis = o.fmtAxis ?? o.fmt;
    el.classList.add("bc");
    let animate = o.animate !== false && !reduced();
    function draw() {
      const W = Math.max(260, Math.round(el.clientWidth || 600));
      const vis = o.series.filter(s => !off.has(s.key)), k = Math.max(1, vis.length), stacked = o.variant === "stacked";
      const top = d => (stacked ? vis.reduce((t, s) => t + Math.max(0, o.value(d.key, s.key)), 0) : Math.max(0, ...vis.map(s => o.value(d.key, s.key))));
      const t = ticks(0, Math.max(1, ...o.groups.map(top)));
      const hi = t.at(-1), iw = W - M.l - M.r, step = iw / Math.max(1, o.groups.length);
      const y = v => M.t + (H - M.t - M.b) * (1 - v / hi), base = y(0);
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const barW = stacked ? clamp(step * 0.62, 3, 46) : clamp((step * 0.74 - 3 * (k - 1)) / k, 3, 34), groupW = stacked ? barW : barW * k + 3 * (k - 1);
      const bar = (x, y0, w, h, r) => { r = Math.min(r, w / 2, h); return `M${f1(x)},${f1(y0 + h)}V${f1(y0 + r)}Q${f1(x)},${f1(y0)} ${f1(x + r)},${f1(y0)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y0)} ${f1(x + w)},${f1(y0 + r)}V${f1(y0 + h)}Z`; };
      let g = t.map(v => `<line class="bc-gl${v === 0 ? " zero" : ""}" x1="${M.l}" x2="${W - M.r}" y1="${f1(y(v))}" y2="${f1(y(v))}"/><text class="ch-axis" x="${M.l - 8}" y="${f1(y(v) + 4)}" text-anchor="end">${esc(fmtAxis(v))}</text>`).join("");
      const every = Math.ceil(o.groups.length / Math.max(1, Math.floor(iw / 72)));
      const fit = Math.max(4, Math.floor((step * every) / 6.6) - 1);                 // characters that fit under a label's share
      o.groups.forEach((d, i) => {
        const c = M.l + step * i + step / 2;
        let acc = 0, bars = "";
        vis.forEach((s, si) => {
          const v = Math.max(0, o.value(d.key, s.key));
          if (!v) return;
          const h = base - y(v);
          if (stacked) { const y1 = y(acc + v); acc += v; bars += `<path class="bc-bar" d="${bar(c - barW / 2, y1, barW, h, si === vis.length - 1 || vis.slice(si + 1).every(x => !o.value(d.key, x.key)) ? 6 : 0)}" fill="${esc(s.color)}" style="--d:${i * 40 + si * 25}ms"/>`; }
          else bars += `<path class="bc-bar" d="${bar(c - groupW / 2 + si * (barW + 3), base - h, barW, h, 6)}" fill="${esc(s.color)}" style="--d:${i * 40 + si * 25}ms"/>`;
        });
        g += `<g class="bc-g" data-i="${i}">${bars}</g>`;
        if (i % every === 0) g += `<text class="ch-axis" x="${f1(c)}" y="${H - 7}" text-anchor="middle">${esc(d.label.length > fit ? `${d.label.slice(0, fit - 1)}…` : d.label)}</text>`;
      });
      el.innerHTML = `<div class="bc-plot"><svg class="bc-svg${animate ? " grow" : ""}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title ?? "Bar chart")}">
          <rect class="bc-band" y="${M.t - 4}" height="${H - M.t - M.b + 4}" width="${f1(step)}" rx="8" opacity="0"/>${g}
          <rect class="bc-hit" x="${M.l}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg><div class="bc-tip" hidden></div></div>
        ${o.series.length > 1 ? `<div class="bc-legend" role="group" aria-label="Series">${o.series.map(s => `<button type="button" class="bc-key${off.has(s.key) ? " off" : ""}" data-s="${esc(s.key)}" aria-pressed="${!off.has(s.key)}"><i style="background:${esc(s.color)}"></i>${esc(s.label)}</button>`).join("")}</div>` : ""}`;
      animate = false;                                                   // grow once; later draws just change
      const svg = el.querySelector(".bc-svg"), band = el.querySelector(".bc-band"), tip = el.querySelector(".bc-tip");
      const show = i => {
        el.querySelectorAll(".bc-g").forEach(x => x.classList.toggle("dim", i !== null && Number(x.dataset.i) !== i));
        if (i === null) { band.setAttribute("opacity", 0); tip.hidden = true; return; }
        const d = o.groups[i];
        band.setAttribute("x", f1(M.l + step * i)); band.setAttribute("opacity", 1);
        const rows = vis.map(s => [s, o.value(d.key, s.key)]).filter(([, v]) => v);
        const total = rows.reduce((t, [, v]) => t + v, 0);
        tip.innerHTML = `<b>${esc(d.label)}</b>${rows.map(([s, v]) => `<span><i style="background:${esc(s.color)}"></i>${esc(s.label)}<em class="num">${esc(o.fmt(v))}</em></span>`).join("")}${rows.length > 1 ? `<span class="bc-total">Total<em class="num">${esc(o.fmt(total))}</em></span>` : ""}`;
        tip.hidden = false;
        const x = M.l + step * (i + 0.5), w = tip.offsetWidth;
        tip.style.transform = `translate(${f1(Math.max(0, Math.min(W - w, x - w / 2)))}px, ${f1(Math.max(0, y(top(d)) - tip.offsetHeight - 10))}px)`;
      };
      const at = e => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(o.groups.length - 1, Math.floor((e.clientX - r.left - M.l) / step))); };
      const hit = el.querySelector(".bc-hit");
      hit.addEventListener("pointermove", e => show(at(e)));
      hit.addEventListener("pointerdown", e => show(at(e)));
      hit.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") show(null); });
      el.querySelector(".bc-legend")?.addEventListener("click", e => {
        const b = e.target.closest("[data-s]");
        if (!b) return;
        if (off.has(b.dataset.s)) off.delete(b.dataset.s); else if (vis.length > 1) off.add(b.dataset.s);
        draw();
      });
    }
    draw();
    let w0 = el.clientWidth;
    new ResizeObserver(() => { if (Math.abs(el.clientWidth - w0) > 4) { w0 = el.clientWidth; draw(); } }).observe(el);
    return { redraw: draw };
  }

  const PALETTE = ["#6d7cff", "#34d1bf", "#ffb44c", "#ff6b8b", "#a78bfa", "#5ac8fa", "#f59f00", "#94a3b8"];

  window.MintyCharts = { bars, lines, legend, ticks, area, donut, stat, wire, segpill, deltaHtml, calendar, barchart, PALETTE };
})();
