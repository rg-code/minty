// Kos's theme before first paint (no flash): light by default (owner, 2026-11-20); dark if chosen. A file,
// not inline, so the page's policy can be script-src 'self'.
document.documentElement.dataset.theme = (() => { try { return localStorage.getItem("kos-theme"); } catch { return null; } })() || "light";
