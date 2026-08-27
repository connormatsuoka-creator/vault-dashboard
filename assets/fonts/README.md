# Typefaces

Two families, self-hosted. **They are served from this origin and nowhere else** —
the page's Content-Security-Policy sets `font-src 'self'`, so a CDN would be
refused by the browser rather than merely discouraged.

| Family | Weights | Licence |
|---|---|---|
| Chakra Petch | 500, 600, 700 | SIL Open Font License 1.1 |
| JetBrains Mono | 400, 500 | SIL Open Font License 1.1 |

## What the licence requires, and what it does not

OFL 1.1 requires that the copyright notice and the licence travel with the font
files when they are redistributed — which self-hosting is. `OFL-*.txt` beside
these files satisfies that in full.

It requires **no visible attribution**: no credit line in the UI, no About box,
nothing user-facing. It also forbids selling the font files by themselves, which
is not something this repo does.

**Neither family declares a Reserved Font Name** — checked against both
copyright lines. That is what makes it unambiguous to ship Google's latin
subsets under the original family names.

## Provenance

Downloaded from `fonts.gstatic.com` via the Google Fonts CSS API, latin subset
only; the other subsets offered (latin-ext, cyrillic, cyrillic-ext, greek,
vietnamese, thai) are not shipped because the vault is English. Licences come
from each project's own repository, not from the CDN.

## Consuming them

```css
@font-face {
  font-family: "Chakra Petch";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("../assets/fonts/ChakraPetch-500.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "Chakra Petch";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("../assets/fonts/ChakraPetch-600.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "Chakra Petch";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("../assets/fonts/ChakraPetch-700.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("../assets/fonts/JetBrainsMono-400.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("../assets/fonts/JetBrainsMono-500.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
```

The four interface marks that used to be text glyphs — the two arrows and the
two disclosure chevrons — are **not** in this subset and are deliberately not
font characters: they are drawn as inline SVG so they inherit `currentColor`
and cannot fall back to another face.
