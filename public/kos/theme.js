// Kos's theme before first paint (no flash): dark by default, like Flighty; light if chosen. A file,
// not inline, so the page's policy can be script-src 'self'.
document.documentElement.dataset.theme = (() => { try { return localStorage.getItem("kos-theme"); } catch { return null; } })() || "dark";
