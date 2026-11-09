# PO PDF fonts

Noto Sans Regular and Bold, subset for the purchase order PDF
(`src/services/purchasing-po-pdf.ts`, bead legend-uokb). SIL Open Font License
1.1, see `OFL.txt`. The tsup build copies this folder into `dist/` (`publicDir`),
so the runtime finds the files at `dist/fonts/`.

Source: release `NotoSans-v2.015` of
https://github.com/notofonts/latin-greek-cyrillic, file
`NotoSans/unhinted/ttf/NotoSans-{Regular,Bold}.ttf`.

Rebuild a subset (fonttools via uvx):

```sh
uvx --from fonttools pyftsubset NotoSans-Regular.ttf \
  --unicodes='U+0020-007E,U+00A0-024F,U+0300-036F,U+0370-03FF,U+0400-052F,U+1E00-1EFF,U+2000-206F,U+20A0-20BF,U+2116,U+2122,U+2190-2193,U+2212,U+2215,U+2248,U+2260,U+2264,U+2265,U+25CA' \
  --layout-features='kern,mark,mkmk,ccmp,locl' --glyph-names --no-hinting \
  --name-IDs='*' --notdef-outline --output-file=NotoSans-Regular-subset.ttf
```

Repeat with `NotoSans-Bold.ttf` for the bold file. A character outside the
subset (CJK, emoji) draws the font's .notdef box; add its range above to cover it.
