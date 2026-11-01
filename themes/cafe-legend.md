# Tenant Theme — Cafe Legend

> **PLACEHOLDER until A1 brand assets arrive.** PRD Kelompok A: Cafe Legend's Tenant Theme is
> "diturunkan dari aset brand Legend (A1) dan diisi oleh Super Admin". No logo, brand colors,
> or brand font exist yet, so this theme is a tasteful warm-neutral stand-in that passes WCAG
> 2.2 AA. It copies no other brand's identity. Replace every value below when A1 lands.

- **Config (source of truth):** `packages/shared/src/theme/tenants/cafe-legend.ts`
  (`cafeLegendTheme`, `placeholder: true`). In production the same object comes from tenant
  settings; no Cafe Legend specific code exists anywhere (D44, R27).
- **Base:** inherits everything in `DESIGN.md`; only the fields below change.
- **Preview:** `/design-system?tenant=cafe-legend`, screenshot
  `docs/design/screenshots/design-system-cafe-legend-1440-light.png`.

## Overrides

| Token                            | Light                 | Dark                  | Idea                               |
| -------------------------------- | --------------------- | --------------------- | ---------------------------------- |
| `primary` / `primary-foreground` | `#8a4423` / `#ffffff` | `#e8a27a` / `#2a1206` | roasted copper — main action       |
| `brand` / `brand-foreground`     | `#6b4f2a` / `#ffffff` | `#d6b48a` / `#241707` | toasted caramel — supporting color |
| `brand-subtle`                   | `#f7efe4`             | `#2a2119`             | cream tint for brand moments       |
| `muted`                          | `#f7f3ee`             | `#24201c`             | warmer quiet surface               |
| `secondary`                      | `#f2ece4`             | `#2c2621`             | secondary button                   |
| `accent`                         | `#f1ebe3`             | `#2e2823`             | hover / selected                   |

| Setting    | Value                                                                        |
| ---------- | ---------------------------------------------------------------------------- |
| Brand font | `plus-jakarta-sans`                                                          |
| Corners    | `lembut` (4px unit)                                                          |
| Logo       | none yet (`logoUrl: null`); shells show the tenant name in `font-brand` bold |

Page background stays white; status colors, neutrals, and focus ring stay Base.

## Contrast

Merged with the Base Theme, all 74 checked pairs pass AA in light and dark
(`tests/design-system.test.mjs`, "Cafe Legend placeholder Tenant Theme passes and activates").

## When A1 arrives (checklist for Super Admin / WS owner)

1. Replace the hex values in `cafeLegendTheme` (or the tenant settings record) with colors
   derived from the brand assets; keep `primary` clearly distinct from `danger` (`#b42318`).
2. Pick the brand font from `BRAND_FONTS`; if the brand needs another family, add it once to
   the allowed list and self-host it (`@fontsource-variable/*`).
3. Set `logoUrl`, `corners`, and remove `placeholder: true`.
4. Run `pnpm check`: the contrast gate refuses any value that fails AA in either mode.
5. Update this file and re-shoot `/design-system?tenant=cafe-legend`.
