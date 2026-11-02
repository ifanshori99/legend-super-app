# DESIGN.md — Legend Super App · Base Theme

> Design System Platform, Base Theme (PRD v1.7 Kelompok A "Design System Platform", D42, R26).
> **Version 2** (2026-11-02, bead legend-6be7): visual-quality upgrade from the getdesign.md
> pattern study in `docs/design/references/README.md`. Owner answers to the review (Q21–Q33)
> applied the same day in the tokens, `components/ui`, and the three shells. Screenshots:
> `docs/design/screenshots/design-v2/` (before/after study) and `design-v2/phase2/` (shipped
> screens). Patterns only — never another brand's colors, logo, type, or signature elements.
> Every screen is built from these tokens and the shared component library. Read this file
> before any UI work. Tenant Themes override a small, checked subset: see `themes/`.
> Live reference: `/design-system` (all tokens, components, states, both modes, three
> densities, three app shells). Screenshots: `docs/design/screenshots/`.

<!-- ryux-context:start -->

- **UI direction**: Calm, warm-neutral, trustworthy task UI on a white background, made premium by a surface ladder, one derived accent spent scarcely, photo-first customer cards, and a real type scale; status always as icon + text
- **Motion direction**: Quiet and functional — state changes and overlays only, 120–320ms, everything off under prefers-reduced-motion

<!-- ryux-context:end -->

## 1. Visual Theme & Atmosphere

Legend is a working tool for a 250–300 seat F&B outlet and the customers in it. The Base Theme
is deliberately quiet: white page, warm greys from a single family, near-black ink, and one
default accent hue (petrol, §2 Brand) that a Tenant Theme replaces with its own. Color appears
only to carry meaning (action, status, timer) or the accent, within the accent budget. It must work in sunlight on a phone at the table, on a
greasy kitchen tablet, and on a finance dashboard read for hours.

- **Default:** light theme on pure white `#ffffff`. Full dark theme via `.dark` on `<html>`
  (class) or the OS setting when the user chooses "Ikuti perangkat"; choice persists in
  `localStorage["legend-theme"]`.
- **Three densities** (PRD), set with `data-density` on a subtree via `<ThemeScope>`:

| Density         | `data-density`     | Used for                                           | Feel                                                                                                | Control height         | Body                        |
| --------------- | ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------- |
| Hangat & Visual | `hangat` (default) | QR order, member, shower, WFC, website, HRIS       | photo-led, rounded, pill CTAs (pattern ref: ordering/rewards and photo-first marketplaces)          | 48px (sm 44, lg 56)    | 16px Plus Jakarta Sans      |
| Kontras Tinggi  | `kontras`          | POS, captain order, KDS, expo, pickup, papan bilik | hard black/white, 2px lines, dark kitchen mode (pattern ref: ride-hailing ops)                      | 60px (sm 56, lg 64)    | 18px Inter                  |
| Padat & Presisi | `padat`            | management, owner, shareholder, finance            | dense tables, tabular figures, quiet (pattern ref: issue trackers, banking and payments dashboards) | 36px mouse, 44px touch | 16px Inter, table data 14px |

Pattern references are for flow, layout, and density only — never another brand's colors,
logo, type, or signature elements (PRD "Batas referensi", D42, R26).

### v2 direction in one paragraph

Neutral stays neutral; what was missing was _systems_. v2 adds (in impact order): the tenant
accent actually used, with a tint ramp derived from it (§2); a three-step surface ladder plus
one interactive elevation (§2, §6); a type scale with display sizes, tracking, and money tiers
(§3); photo-first cards where every menu item has a photo (§4 Media); a band
rhythm for customer pages, a status hierarchy for ops boards, and a grouped management shell
(§5); purposeful empty/loading states, press feedback, a true dark ladder, a chart style, and
an icon stroke rule (§4, §7, §10, §11). Densities, control heights, and the contrast gate are
unchanged in contract; they now cover the new tokens.

**Owner decisions (2026-11-02, review `docs/design/design-v2-review.html`):** accent scarce —
one filled accent area plus at most two accent details per viewport (Q21); borderless
photo-first menu cards (Q22); **every menu item has a photo** — no placeholder art, a skeleton
while loading, and a "Foto wajib" state in back office; the menu contract refuses publishing
without one (Q23); Unsplash sample photos only in mock/demo data (Q24); urgent ops state =
solid pill + thick start rule (Q25); late KDS ticket = full red header (Q26); occupied table =
warm grey (Q27); grouped management sidebar 256px + 64px icon rail (Q28); selected row = accent
tint + start rule (Q29); related metrics in one stat strip (Q30); the Base Theme gets a default
hue (Q31); warm dark ladder (Q32).

## 2. Color Palette & Roles

Tokens are CSS custom properties in `apps/web/src/styles/tokens.css`, mirrored in
`packages/shared/src/theme/base.ts`. A test fails if the two drift. Names are roles, never
values. Use the Tailwind class (`bg-primary`, `text-muted-foreground`, …), never a hex.

### Neutrals

| Role            | Token / class                          | Light     | Dark      | Use                                                                           |
| --------------- | -------------------------------------- | --------- | --------- | ----------------------------------------------------------------------------- |
| Page (step 1)   | `background`                           | `#ffffff` | `#0f0e0d` | page and field fill                                                           |
| Text            | `foreground`                           | `#1c1b19` | `#f3f1ee` | body text, icons                                                              |
| Surface         | `card` (`bg-card`, alias `bg-surface`) | `#ffffff` | `#1b1a18` | cards, popovers, sheets                                                       |
| Band (step 2)   | `surface-2`                            | `#f7f6f4` | `#161513` | customer bands, management sidebar, table header, search pill, summary footer |
| Raised (step 3) | `surface-3`                            | `#f1efec` | `#242220` | occupied table, hovered nav item, skeletons, media gaps, counters             |
| Muted surface   | `muted`                                | `#f5f4f2` | `#211f1d` | disabled fields, skeleton                                                     |
| Hint text       | `muted-foreground`                     | `#5f5b55` | `#aaa59d` | secondary text, captions (AA on all surfaces)                                 |
| Secondary fill  | `secondary`                            | `#f0eeeb` | `#2a2825` | secondary button                                                              |
| Hover/selected  | `accent`                               | `#efedea` | `#2c2a27` | hovered row/menu item, selected nav (shadcn meaning)                          |
| Divider         | `border`                               | `#e3e0dc` | `#2f2c29` | decorative separators only                                                    |
| Field edge      | `input`                                | `#8a857d` | `#7c776f` | input/checkbox borders (≥3:1, WCAG 1.4.11)                                    |

**Surface ladder (v2).** Step 1 is the page, step 2 a band or canvas (`bg-surface-2`), step 3
something raised or selected (`bg-surface-3`). Cards stay `bg-card` (white in light) with their
1px border on step 1 and need no border on step 2 — the tone difference is the edge. Never
stack more than one step per region. **Dark ladder:** page `#0f0e0d` → band `#161513` → card
`#1b1a18` → raised `#242220`; lighter means closer, shadows are not relied on. Kontras dark
(dapur gelap) uses `#000000` → `#0b0a0a` → `#121110` → `#1c1b19`. Surface tokens are neutrals:
tenants cannot override them.
| Focus | `ring` | `#1f5fbf` | `#7aaaf0` | the one focus indicator (2px outline, 2px offset) |

### Brand (Tenant Themes override these)

| Role             | Token                            | Light                 | Dark                  | Use                                                        |
| ---------------- | -------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------- |
| Main action      | `primary` / `primary-foreground` | `#0f5e68` / `#ffffff` | `#5ec2cc` / `#04262a` | the one primary CTA per view, links, checked controls      |
| Supporting brand | `brand` / `brand-foreground`     | `#3d3a35` / `#ffffff` | `#d9d5cf` / `#1c1b19` | tenant's "warna pendukung": tier cards, secondary emphasis |
| Brand tint       | `brand-subtle`                   | `#f3f1ee`             | `#262421`             | quiet brand backgrounds with `foreground` text             |

### Accent ramp — derived, not configured (v2)

Owner decision (2026-11-02): one accent per tenant. Everything else in the ramp is **mixed from
`primary`** in CSS (`color-mix(in srgb, …)`, `tokens.css`) and the same sRGB mix in
TypeScript (`DERIVED_TOKENS`, `derivePalette`), so the contrast gate checks exactly what
renders and a Tenant Theme gets the ramp for free. There is no second accent token.

| Token / class         | Mix                            | Use                                                                     |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `primary-hover`       | 88% primary into background    | hover of filled primary buttons (replaces `/90`)                        |
| `primary-tint`        | 10% primary into background    | selected nav row, selected table row, accent badge, selected option row |
| `primary-tint-strong` | 18% primary into background    | stronger accent wash (accent label background)                          |
| `chart-accent`        | = primary                      | the one highlighted series                                              |
| `chart-neutral`       | 55% foreground into background | comparison series, axis baseline (≥3:1 on cards)                        |
| `chart-grid`          | = border                       | horizontal gridlines only                                               |

**Accent budget (per viewport):** one filled accent surface (the primary CTA, or the cart bar)
plus at most two accent details (active nav, one accent badge or link). Filters and segmented
controls select in **ink** (`bg-foreground text-background`) or white-on-`surface-2`, not in
accent. Empty-state glyphs, skeletons, and media gaps stay neutral so they never spend the
budget.

**Base Theme default hue (owner Q31): petrol** — light `#0f5e68` (7.4:1 on white, white text
7.4:1), dark `#5ec2cc` with `#04262a` text (9.2:1 on the dark page). Chosen to sit far from the
Cafe Legend copper placeholder (hue ~20° vs ~190°), away from the status hues (success green
~150°, info blue ~215°), and outside the indigo/violet range that reads as generic AI UI. A
Tenant Theme replaces it; the derived ramp follows automatically.

### Status (fixed across tenants so meaning never changes)

Each has a solid fill, text on the fill, and a tint. The solid color is also AA as text on
`background`, `card`, and its own tint.

| Status                            | solid / on-solid / tint (light)   | solid / on-solid / tint (dark)    |
| --------------------------------- | --------------------------------- | --------------------------------- |
| `success`                         | `#18794e` / `#ffffff` / `#e9f5ee` | `#4cc38a` / `#05251a` / `#132a1f` |
| `warning`                         | `#9a5b06` / `#ffffff` / `#fdf3e2` | `#eea64a` / `#2a1803` / `#2e2312` |
| `danger` (= shadcn `destructive`) | `#b42318` / `#ffffff` / `#fdecea` | `#f47b70` / `#2b0805` / `#341815` |
| `info`                            | `#1f5fbf` / `#ffffff` / `#eaf1fc` | `#7aaaf0` / `#0a1a33` / `#15223a` |

### Order and KDS timer statuses (aliases, no new hues)

| Meaning (PRD)                         | Token             | Maps to | Pill                               |
| ------------------------------------- | ----------------- | ------- | ---------------------------------- |
| Diterima (ORD Status Pesanan)         | `order-received`  | info    | `<StatusPill status="received" />` |
| Diproses                              | `order-preparing` | warning | `status="preparing"`               |
| Siap                                  | `order-ready`     | success | `status="ready"`                   |
| Diantar                               | `order-delivered` | muted   | `status="delivered"`               |
| KDS timer on target (KDS per Stasiun) | `timer-on-track`  | success | `status="onTrack"`                 |
| Near target                           | `timer-near`      | warning | `status="near"`                    |
| Past target                           | `timer-late`      | danger  | `status="late"`                    |

Timer thresholds come from each station's target time in configuration; the design system
never hard-codes minutes.

### Kontras Tinggi overrides

`[data-density="kontras"]` tightens neutrals: light → text `#000000`, hint `#3d3a35`, lines
`#8a857d`, field edge `#3d3a35`. Dark ("dapur gelap") → page `#000000`, text `#ffffff`, surface
`#121110`, hint `#d0cbc3`, lines `#5c5852`.

### Contrast gate (automatic)

`packages/shared/src/theme/contrast.ts` checks 50 foreground/background pairs per mode (100
total, v2 adds the surface ladder, the derived accent ramp, and the neutral chart series)
against WCAG 2.2 AA: 4.5:1 text, 3:1 field borders and focus ring. Base, Kontras, and
every Tenant Theme must pass in **both** modes; `buildTenantThemeCss` refuses a failing theme
and the Base Theme stays active (PRD: "tema yang gagal tidak dapat diaktifkan"). Adding a
component that puts a token on a new surface means adding that pair to `REQUIRED_PAIRS`.

## 3. Typography Rules

| Family                     | Token / class                      | Where                       |
| -------------------------- | ---------------------------------- | --------------------------- |
| Plus Jakarta Sans Variable | `font-brand` (body in Hangat)      | customer and brand surfaces |
| Inter Variable             | `font-ui` (body in Kontras, Padat) | POS, KDS, dashboards        |
| System mono                | `font-mono`                        | code, token names only      |

Both fonts are self-hosted (`@fontsource-variable/*`), so they load from the edge node when the
internet is down. A tenant may switch the brand font from the allowed list (`BRAND_FONTS`).

v2 type scale. Steps are `type-*` utilities (`globals.css`) that set size, line height,
weight, and tracking together; color stays a separate class. They are named `type-*`, not
`text-*`, so `cn` never drops a color (see the gotcha below). Display is **600 with negative
tracking** — size carries hierarchy, not weight.

| Step          | Class                | Size / line · weight · tracking      | Use                                                    |
| ------------- | -------------------- | ------------------------------------ | ------------------------------------------------------ |
| Display 2XL   | `type-display-2xl`   | 40→56 / 1.07 · 600 · −0.03em (fluid) | website and customer hero, one per page                |
| Display XL    | `type-display-xl`    | 34→44 / 1.1 · 600 · −0.025em (fluid) | customer page title ("Menu"), design board titles      |
| Display       | `type-display`       | 32/40 · 600 · −0.02em                | management page title, ops board title, cart count     |
| Title         | `type-title`         | 22/28 · 600 · −0.015em               | section heading ("Kopi"), sheet item name              |
| Heading       | `type-heading`       | 17/24 · 600 · −0.01em                | card, panel, option-group headings                     |
| Body          | inherited            | 16 (18 Kontras) / 24                 | all running text — do not set it                       |
| Small         | `text-sm`            | 14/20                                | hints, captions                                        |
| Eyebrow       | `type-eyebrow`       | 12/16 · 600 · +0.06em · uppercase    | context above a title, nav group labels, table headers |
| Micro         | `text-xs`            | 12/16                                | badges, counters only                                  |
| Money display | `type-money-display` | 32/36 · 600 · −0.02em · tabular      | stat values, cart/sheet totals (`<Money size="stat">`) |
| Money hero    | `type-money-hero`    | 44/48 · 600 · −0.03em · tabular      | the one big amount on a payment screen (`size="hero"`) |

- **Money tiers:** `<Money size="stat" | "hero">` renders the `Rp` prefix at 0.6em in
  `muted-foreground`, raised, so the figure carries the weight; `inline` sizes stay as before.
  Right-aligned in tables (`numeric`), true minus `−`, always `tabular`.
- **Weights:** 400 body, 500 labels and nav, 600 headings/display/money, 700 only for the
  wordmark and Kontras table codes. No 800/900.

- **Numbers:** every amount, count, time, and code uses `tabular` (tabular figures). Money is
  always `<Money amount={…} />` (→ `formatRupiah`: `Rp 25.000`, no-break space, minus `−`).
- Body is inherited. To size something "like body" explicitly use
  `text-(length:--density-text)` (or `--density-text-data` for table data). **Never** add a
  `text-<customname>` font-size class: `cn` (tailwind-merge) reads it as a color and silently
  drops the real text color.
- Base text is 16px minimum for reading (PRD Kemudahan pakai).

## 4. Component Stylings

All components live in `apps/web/src/components/ui` (shadcn/ui pattern on Radix, owned in
repo). Search there before creating anything; extend with a variant, never fork per screen.

| Component              | File                            | Notes                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                 | `button.tsx`                    | variants `default` (primary), `brand`, `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `default/sm/lg/icon/icon-sm` from density; `loading` shows spinner + `aria-busy` and blocks repeats. One `default` button per view. v2: hover `primary-hover`, press `pressable` (scale 0.97).                                                                             |
| Input, Textarea        | `input.tsx`, `textarea.tsx`     | `fieldClass`: `input` border, `rounded-field`, 2px danger border when `aria-invalid`                                                                                                                                                                                                                                                                                            |
| Select                 | `select.tsx`                    | Radix Select; trigger looks like a field; popover `shadow-overlay`                                                                                                                                                                                                                                                                                                              |
| Checkbox, Switch       | `checkbox.tsx`, `switch.tsx`    | size from `--check-size` (16/20/28px); always pair with a `<Label htmlFor>` that is the touch target                                                                                                                                                                                                                                                                            |
| Label                  | `label.tsx`                     | 14px semibold                                                                                                                                                                                                                                                                                                                                                                   |
| FormField              | `form-field.tsx`                | label + control + hint + error; wires `id`, `aria-describedby`, `aria-invalid`, `aria-required`; error announced via `aria-live`; optional fields marked "(opsional)". `fieldErrors(zodError)` maps a Zod error to messages. Zod built-ins speak Indonesian (`z.config(z.locales.id())`). Every error says how to fix it.                                                       |
| Dialog                 | `dialog.tsx`                    | bottom sheet on phones, centered from `sm`; focus trap, Escape, focus returns to trigger                                                                                                                                                                                                                                                                                        |
| Sheet                  | `sheet.tsx`                     | right/left/bottom panel (cart, filters, mobile nav)                                                                                                                                                                                                                                                                                                                             |
| DropdownMenu           | `dropdown-menu.tsx`             | `destructive` items are red text; confirm destructive actions in a Dialog                                                                                                                                                                                                                                                                                                       |
| Tabs                   | `tabs.tsx`                      | underline tabs, arrow-key navigation                                                                                                                                                                                                                                                                                                                                            |
| Table                  | `table.tsx`                     | `h-row` rows, `numeric` cells right-aligned tabular; scrolls inside its container                                                                                                                                                                                                                                                                                               |
| DataTableShell         | `data-table-shell.tsx`          | every list: title, search, actions, **loading / empty / no-results / error**, row count, pagination                                                                                                                                                                                                                                                                             |
| Card                   | `card.tsx`                      | flat, 1px border, `rounded-container`, `p-card`, `type-heading` title; no shadow; never nest cards                                                                                                                                                                                                                                                                              |
| Badge, StatusPill      | `badge.tsx`                     | Badge = short label/count (tint + strong text). StatusPill = order/timer/status with **icon + text**, never color alone; `solid` only for the one state that needs action now (late, waiter call; owner Q25)                                                                                                                                                                    |
| Toast                  | `toast.tsx`                     | `useToast()({ title, description, tone })` confirms finished actions only; errors the user must fix stay next to the field                                                                                                                                                                                                                                                      |
| Skeleton               | `skeleton.tsx`                  | shaped like the content; the region sets `aria-busy` + sr-only "Memuat…"                                                                                                                                                                                                                                                                                                        |
| EmptyState, ErrorState | `feedback-state.tsx`            | functional glyph (56px circle, neutral `surface-3` for empty, danger tint for error) + title + one-sentence hint + one next action; ErrorState has `role="alert"` and "Coba lagi"                                                                                                                                                                                               |
| StatTile, StatStrip    | `stat-tile.tsx`                 | label, `type-money-display` value, period, **link to source data** (PRD); no decorative deltas or sparklines. Related metrics go in one `StatStrip` (one container, hairline dividers, 1 / 2 / `columns` columns; owner Q30)                                                                                                                                                    |
| Money, NumberDisplay   | `money.tsx`                     | `<data value>` + tabular figures; v2 sizes `stat` / `hero` scale the `Rp` prefix (§3)                                                                                                                                                                                                                                                                                           |
| MediaPlate             | `media-plate.tsx`               | v2. Photo only (owner Q23): locked aspect (`card` 1:1, `hero` 3:2, `thumb` 4:5), `rounded-media`, lazy `<img>` behind a skeleton until loaded; a missing photo shows `missing="required"` ("Foto wajib", back office) or a quiet neutral plate (customer); overlay slots `topStart` (status badge), `topEnd` / `bottomEnd` (one action); `muted` for sold out; optional `scrim` |
| QrCode                 | `qr-code.tsx`                   | the only QR renderer (`uqr`, bead legend-9fmm): one SVG path, `<title>` as accessible name, always-light plate in both modes so codes scan; `size`, `margin` (quiet zone), `level`                                                                                                                                                                                              |
| SegmentedControl       | `segmented-control.tsx`         | 2–4 options (theme, density, view); radio group semantics                                                                                                                                                                                                                                                                                                                       |
| ThemeSwitcher          | `components/theme-switcher.tsx` | Terang / Gelap / Ikuti perangkat                                                                                                                                                                                                                                                                                                                                                |
| ThemeScope             | `components/theme-scope.tsx`    | sets `data-density` / `data-theme` / `data-tenant` on a subtree **and** makes overlays portal into it                                                                                                                                                                                                                                                                           |

**States, defined once:** default · hover (`accent` fill or `/90`) · focus-visible (global 2px
`ring` outline, 2px offset) · pressed · disabled (50–60% opacity, no pointer) · loading
(`aria-busy`, spinner) · invalid (`aria-invalid`, danger border + message).

### Media and the photo-first card (v2)

The single biggest "plain" signal was letter tiles. Customer surfaces lead with photos:

- **Menu card:** `MediaPlate ratio="card"` (1:1, `rounded-media`), status badge top-left on the
  photo (`Terlaris` / `Baru` / `Pedas` / `Habis`, white pill on `bg-card`), round add button
  bottom-right on the photo (40px, `bg-card shadow-card`, `aria-label="Tambah <nama>"`), then
  name (semibold, 2 lines max), one-line description (`text-sm muted`), price (`<Money>`
  semibold). No card border or padding around it — the plate is the container. Two columns on
  phones, more on wider containers.
- **Carousel card:** `ratio="thumb"` (4:5), 148px wide, inside a `surface-2` band.
- **Item sheet:** full-bleed `ratio="hero"` photo at the top of the sheet, round close and
  favorite buttons on the photo, then badges, `type-title` name, description, `<Money
size="stat">`.
- **Cart / list thumb:** 72px square plate, `rounded-media`.
- **Photo required (owner Q23):** every menu item has a photo; publishing without one is
  refused by the menu contract (separate contract/backend bead). Design the card for photos
  only: a skeleton while the image loads, never a letter tile or decorative placeholder. Back
  office shows the gap with `MediaPlate missing="required"` ("Foto wajib") next to the upload
  action so it gets fixed.
- **Sold out:** photo `muted` (greyscale, 55%), `Habis` badge, no add button, text muted.
- **Text on a photo** only with `scrim` (`--scrim-media`, a functional bottom gradient); prefer
  text below the photo.
- **Sample photos (owner Q24):** Unsplash License sample images are allowed only in mock/demo
  data, always under a "Contoh data" label (the eight used in the v2 study are in commit
  `996bcfe`, `apps/web/public/sample/menu/`); real menus use the tenant's uploads (storage
  pipeline strips EXIF, emits WebP).

### Empty and loading (v2)

Skeletons mirror the content shape: media plates as `aspect-card rounded-media` blocks, rows as
`h-row` bars, tables as header + 5 rows. Empty states carry a functional glyph (what is missing,
e.g. a basket for an empty cart), one sentence, and one next action ("Lihat menu"). No
decorative illustration.

Platform-specific components named in the PRD (table status card/map, KDS ticket with timer,
shower access ticket, Wi-Fi quota meter, member tier card, approval card, Tanya AI answer with
sources) are built per workstream **from these primitives and tokens**; `/design-system` shows a
KDS ticket composed this way.

## 5. Layout Principles

**Spacing:** Tailwind 4px scale (`1`=4px … `16`=64px). Density-driven names:
`h-control`, `h-control-sm`, `h-control-lg`, `px-control-x`, `h-row`, `p-card`, `px-gutter`,
`size-check`, `size-icon`. Prefer these over raw numbers for anything density-sensitive.

**Radius:** every radius is a multiple of `--radius-unit` (4px; tenants: tegas 2px, lembut
4px, bulat 6px): `rounded-xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `2xl` 24 ·
`rounded-control` (pill in Hangat, 8px Kontras, 6px Padat) · `rounded-field` · `rounded-full`
for pills/avatars. Shape lock: controls `rounded-control`, fields `rounded-field`, containers
`rounded-container`, sheets `rounded-t-sheet`.

**Radius intents (v2)** — aliases over the same scale, use these names in new code:
`rounded-media` (3 units = 12px: photos, thumbs, their skeletons; never pill) ·
`rounded-container` (4 units = 16px: cards, panels, table wrappers, ops tiles) ·
`rounded-control` (per density, above) · `rounded-sheet` (6 units = 24px: bottom sheets,
`rounded-t-sheet`). Chips, search pills, steppers, and the cart bar are `rounded-full` in
Hangat. Aspect locks: `aspect-card` 1:1, `aspect-hero` 3:2, `aspect-thumb` 4:5.

**App shells** (`apps/web/src/components/shells/`):

| Shell             | Density | Structure                                                                                                                                                                 |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomerShell`   | hangat  | header (tenant name/logo + context like "Meja 12 · 3 tamu"), one scrolling column `max-w-2xl`, bottom nav (≤5 items, 64px, safe-area padding)                             |
| `OperationsShell` | kontras | full screen, status bar (screen, outlet · station, connection, outlet clock in its own time zone), work area owns the rest; `mode="dark"` for kitchen                     |
| `ManagementShell` | padat   | grouped sidebar 256px from 80rem shell width, 64px icon rail from 64rem, Sheet behind a menu button below; topbar 56px (container queries, so it adapts to its own width) |

### Surface composition (v2)

**Customer (Hangat) — band rhythm.** White top (title, search pill on `surface-2`, ink filter
chips) → `surface-2` band for one featured carousel → white category sections with
photo-first grids → the cart bar floats bottom (`bg-primary`, `rounded-full`, count disc +
"Lihat keranjang" + total; the page's one filled accent surface). An optional ink band
(`<ThemeScope mode="dark">` + `bg-surface-2`) is allowed **once** per page for a ceremony
moment (tier upgrade, reward unlocked). Bottom nav: active item in `text-primary` semibold (one
accent detail); count bubbles in `bg-primary`. Page stays white by default.

**Operations (Kontras) — status hierarchy (owner Q25–Q27).** Status bar on `surface-2`.
"Perlu tindakan" strip first (solid pill for the
urgent count, tints for the rest). Zones are a segmented control with counts (`surface-2`
track, `bg-card` selected). Table tiles (`rounded-container`): empty = card + border; occupied
= `surface-3`, no border; **urgent** (waiter call, late) = solid status pill + 2px border +
6px start rule in the status color; calm attention (bill requested) = tint pill on `surface-3`;
cleaning = dashed border; inactive = `surface-2`, muted. Table code 30/36 semibold. Tiles are one column below 40rem, then 2 / 3 / 4 columns. KDS tickets
carry their timer state in a **full-width header band** (late = solid `danger`, near =
`warning-subtle`, on track = `surface-3`) with table, order code (mono), channel, elapsed time
(30px tabular), and the state in words; quantities in a 44px `surface-3` square; critical
modifiers ("Tanpa gula") as a warning flag, never color alone.

**Management (Padat) — grouped shell (owner Q28–Q30).** Sidebar 256px on `surface-2`: brand
block on top (ink square + tenant name), ungrouped items (area index, notifications), then
groups under `type-eyebrow` labels (Operasional, Keuangan, Tim), `footerNav` at the bottom.
A feature puts its item in a group with `group: "operations" | "finance" | "team"` in its
`features/<ws>-<name>/nav.ts` (`NAV_GROUPS` in `lib/areas/nav.ts`; labels `nav.group.*`).
Selected row = `primary-tint` fill + 2px `primary` start rule + semibold `text-primary`.
Between 64rem and 80rem the sidebar is a 64px icon rail (label as `title` + screen-reader
text, groups split by hairlines); below 64rem it moves into the Sheet. Topbar 56px: page title,
page actions, account. Dashboard order: "Perlu perhatian"
(each row with its action) → one **stat strip** (one container, cells split by hairlines, each
with period and a source link — not four identical cards) → chart → tables. Tables sit in a
`rounded-container` with a toolbar (title, segmented filter, search), `surface-2` header in
`type-eyebrow`, `surface-2` row hover, mono codes, `numeric` money.

Routes pass `nav` items with `current` from the router and a `LinkComponent` wrapping the
router `Link` for client navigation. Shells render `<main id="main-content">` (skip link target).

**Responsive:** 360px to ≥1440px (PRD). Mobile first. No horizontal page scroll at any width;
wide tables scroll inside their container with the key column first; dialogs become bottom
sheets on phones; primary actions stay in thumb reach.

**Gotcha:** an implicit `grid` sizes its column to max-content. Any grid holding tables,
truncated text, or long rows needs `grid-cols-[minmax(0,1fr)]` (or explicit columns) and
`min-w-0` on flex children, or it overflows on phones.

## 6. Depth & Elevation

Flat by default. Separation comes from 1px `border` and surface tone, not shadows.

| Level   | Class                       | Use                                                                                              |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| 0       | —                           | page, cards, tables, stat tiles (tone + 1px border do the work)                                  |
| Raised  | `shadow-raised`             | the selected segment, badges on photos, draggable items                                          |
| Card    | `shadow-card`               | v2: interactive lift only — hovered/selected card, floating add button, cart bar, sticky summary |
| Overlay | `shadow-overlay` + `border` | menus, select popovers, dialogs, sheets, toasts                                                  |
| Scrim   | `bg-scrim`                  | behind dialogs/sheets                                                                            |

Order of preference for separation: **tone** (surface ladder) → **hairline** (`border`) →
**shadow** (only for something that floats or responds).

In dark mode shadows barely read, so overlays always keep their border.

## 7. Motion

| Token                      | Value                                               | Use                                       |
| -------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `--duration-fast`          | 120ms                                               | hover, press, color changes               |
| `--duration-base`          | 200ms                                               | menus, toasts, popovers                   |
| `--duration-slow`          | 320ms                                               | sheets, dialogs                           |
| `ease-standard`            | `cubic-bezier(0.2,0,0,1)`                           | default                                   |
| `ease-enter` / `ease-exit` | `cubic-bezier(0,0,0,1)` / `cubic-bezier(0.3,0,1,1)` | entering / leaving                        |
| `ease-sheet`               | `cubic-bezier(0.32,0.72,0,1)`                       | v2: sheets, cart bar enter (no overshoot) |
| `pressable` utility        | scale `--press-scale` 0.97 on `:active`, fast       | v2: buttons, tappable cards, add buttons  |

v2 micro-interactions: press scale on every tappable element; sheets enter with `ease-sheet`
over `--duration-slow` and a 12px rise; the cart bar slides up once when the first item is
added; the cart count pops once (scale 1 → 1.15 → 1) on add; money totals may count up over
240ms when they change (money only). `--press-scale` becomes 1 under reduced motion.

Motion only communicates state, continuity, or feedback. No looping, floating, or
scroll-triggered decoration. Under `prefers-reduced-motion: reduce` every duration becomes 0
(CSS) and `motion/react` honors it via `MotionConfig reducedMotion="user"`.

## 8. Do's and Don'ts

**Do**

- Use tokens and shared components only; if something is missing, add a token or variant here
  first (one place), then use it.
- Keep the page white in light mode; put color on what it means.
- Show every list's loading, empty, and error state (PRD); give every error a fix hint.
- Pair every status color with an icon and text.
- Use `<Money>` / `formatRupiah` for every amount and `tabular` for every number column.
- Put all UI text in `packages/shared/src/i18n/messages/id.ts` and read it with
  `const t = useT()`. Tenant wording goes through catalog overrides, never code.
- Label sample content as "Contoh data" and keep it out of shipped screens.

**Don't**

- No raw colors (hex, `rgb()`, `bg-white`, `text-black`) outside `tokens.css` —
  `node scripts/ci/color.mjs` fails the build.
- No tenant-specific code or branches on tenant id/name/domain (`scripts/ci/tenant-hardcode.mjs`,
  R27). Tenant differences are configuration.
- No purple/blue gradient washes, glassmorphism, glow, emoji icons, decorative illustrations,
  bento grids, or fake app mockups.
- No invented numbers, ratings, testimonials, people, urgency, or business rules; no lorem.
- No cards inside cards; no shadow on resting surfaces; no second primary button in a view.
- No `text-<customname>` size classes (see Typography); no `dark:` overrides where a token
  already switches.
- Never copy another brand's colors, logo, or signature elements.
- No letter tiles or placeholder art for missing photos (menu items require a photo; back office
  shows `MediaPlate missing="required"`); no accent fill on
  filters, chips, or more than one surface per viewport; no display sizes on task UI beyond
  `type-display` for the page title.

## 9. Theming (two layers)

1. **Base Theme** — this file + `tokens.css`. Light on `:root`, dark on `.dark` / `[data-theme="dark"]`.
2. **Tenant Theme** — a `TenantThemeConfig` object (from tenant settings, filled by Super Admin):
   `colors.light/dark` for `primary`, `primary-foreground`, `brand`, `brand-foreground`,
   `brand-subtle`, `muted`, `secondary`, `accent`; `font` from `BRAND_FONTS`; `corners`
   (`tegas`/`lembut`/`bulat`); `logoUrl`. `buildTenantThemeCss(config)` validates it (AA in
   both modes, safe id) and emits a CSS layer scoped to `[data-tenant="<id>"]`;
   `<TenantThemeStyle tenant={config} />` renders it. Set `data-tenant` on `<html>` (resolved
   from the domain) or on a `<ThemeScope>`. Status colors, neutrals, and the focus ring are not
   overridable, so meaning stays consistent. Files: `themes/<tenant>.md`.

The theme preference script runs before first paint (`ThemeBootScript` in `Providers`), so
dark-mode users never see a white flash.

## 10. Data visualization (v2)

Management charts are quiet and answer one question each. One highlighted series in
`chart-accent`; comparison in `chart-neutral` (as a 2px line or marker, not a second loud
color); horizontal gridlines only in `chart-grid`; a 1px `chart-neutral` baseline; axis labels
`text-xs muted tabular`; bars `rounded-t-[3px]`; lines 2px. A legend only when there are two
series. Chart sits in a `rounded-container` card with a `type-heading` title and a one-line
unit/period caption. Empty chart = the empty state text, never an empty grid. Every chart has
an `aria-label` that states what it shows. StatTile's rule stands: no decorative deltas or
sparklines.

## 11. Iconography (v2)

lucide only. Stroke **1.75** in Hangat/Padat, **2** in Kontras (set globally in
`globals.css` on `svg.lucide`). Sizes: 16 (Padat inline), 20 (default), 24 (Kontras). Icons sit
next to a text label unless the control has an `aria-label`. Active nav = tint pill behind the
icon (`primary-tint`), not a filled glyph swap. Icons inside status pills always pair with the
word. No emoji, no sparkle/robot "AI" icons.

## 12. Agent Prompt Guide

Paste into any UI brief:

> Build this screen for Legend Super App using only the design system. Read `DESIGN.md` and open
> `/design-system`. Wrap the screen in the right shell (`CustomerShell` / `OperationsShell` /
> `ManagementShell`), which sets the density. Use components from `@/components/ui` and tokens
> by role (`bg-card`, `text-muted-foreground`, `bg-primary`, …) — no hex, no `bg-white`. Every
> amount uses `<Money>`; every number column is `numeric`/`tabular`. Every list goes through
> `DataTableShell` or shows loading, empty, and error states. Forms use `FormField` with Zod
> errors that say how to fix the input. All text comes from the catalog via `useT()`; add new
> keys to `packages/shared/src/i18n/messages/id.ts`. Status is `StatusPill` (icon + text). No
> tenant names or ids in code. Check 390px and 1440px in light and dark, and run
> `node scripts/ci/color.mjs` and `node scripts/ci/tenant-hardcode.mjs`.

Quick picks:

- Customer menu item (v2): `MediaPlate` 1:1 with badge top-left and round add button
  bottom-right, then name `font-semibold line-clamp-2`, description `text-sm
text-muted-foreground line-clamp-1`, `<Money>` semibold. No card border or padding.
- KDS ticket (v2): `OperationsShell mode="dark"`, `rounded-container border-(length:--border-w)
bg-card`, full-width header band by timer state, table `text-3xl font-bold`, elapsed 30px
  tabular, qty squares on `surface-3`, full-width primary "Selesai".
- Dashboard (v2): grouped sidebar, "Perlu perhatian" first, one stat strip with source links,
  one-accent chart, `DataTableShell` table with toolbar.
