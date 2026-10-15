// Set the theme before first paint (no flash): the saved choice wins, otherwise follow the OS.
// Shared by every page, loaded render-blocking in the head; a file rather than inline so the pages'
// Content-Security-Policy can be script-src 'self'.
document.documentElement.dataset.theme = localStorage.getItem("minty-theme")
  || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
