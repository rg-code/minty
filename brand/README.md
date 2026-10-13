# Minty brand

The Minty logo is a **mint leaf struck on a coin**. "Mint" is both the plant and the place money is
made, and the leaf is a nod to the original Mint app, which inspired this project (none of
Intuit's marks are used). Designed 2026-10-13.

| File | Use |
|---|---|
| `minty-logo.svg` / `.png` | Logo: coin + "minty", on light backgrounds |
| `minty-logo-dark.svg` / `.png` | Logo on dark backgrounds |
| `minty-coin.svg`, `minty-coin-1024.png` | The coin alone, 96 px and up (legend: MINTY · EST · 2026) |
| `minty-coin-self-hosted.svg` | The coin inside the logo (legend: SELF-HOSTED · EST · 2026, so it doesn't repeat the wordmark) |
| `minty-mark.svg` | The simplified coin for small sizes (no legends or denticles). The app's favicon and header use this |
| `minty-wordmark.svg`, `minty-wordmark-light.svg` | "minty" on its own |
| `apple-touch-icon.png` | Home-screen icon (180 px) |

The app serves its copies from `public/`: `favicon.svg`, `favicon-32.png` and
`apple-touch-icon.png`. The dashboard header inlines the wordmark in the page's ink colour, so it
follows light and dark mode.

**Colours**

| Colour | Hex |
|---|---|
| Coin | `#0f4d3c` |
| Rim (light to shade) | `#3f9a7c` → `#08362a` |
| Leaf (light / dark half) | `#8fe6bf` / `#2db37c` |
| Legend | `#c8f3df` |
| Wordmark ink | `#0f3d33` (dark mode: `#e8f5ef`) |
| *i*-dot | `#2db37c` (dark mode: `#5fd3a0`) |

**Type:** the wordmark and the coin's legends are [Manrope](https://github.com/sharanda/manrope)
(600 and 700), converted to outlines, so no font is needed. Manrope is licensed under the SIL Open
Font License 1.1, which allows its use in logos.

**Rules:** don't rotate or recolour the coin, and keep clear space of at least one leaf width
around it. Use `minty-mark.svg` below 96 px; the legends turn to noise there.
