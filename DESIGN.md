# DESIGN.md — Legend Super App · Base Theme

> Design System Platform, Base Theme (PRD v1.7 Kelompok A "Design System Platform", D42, R26).
> **Version 3** (2026-11-02, bead legend-iwrq): visual language rebuilt on the DesainPakeAI
> "Metoric Design System" (layering, double-shell cards, one type family, status badges, table
> density) while keeping Legend's palette and every v2 behavioural decision (Q21–Q33). Where
> Metoric and a Legend decision conflict, Legend wins; each conflict is listed in §13.
> Screenshots: `docs/design/screenshots/legend-iwrq/` (v3), `design-v2/` (v2 study).
> Patterns only — never another brand's colors, logo, type, or signature elements.
> Every screen is built from these tokens and the shared component library. Read this file
> before any UI work. Tenant Themes override a small, checked subset: see `themes/`.
> Live reference: `/design-system` (all tokens, components, states, both modes, three
> densities, three app shells).

<!-- ryux-context:start -->

- **UI direction**: Calm, warm-neutral, layered task UI — canvas → 18px shell → 12px card — in one family (Plus Jakarta Sans), one petrol accent spent scarcely, photo-first customer cards, status always as icon + text
- **Motion direction**: Quiet and functional — state changes and overlays only, 120–320ms, everything off under prefers-reduced-motion

<!-- ryux-context:end -->

## 1. Visual Theme & Atmosphere

Legend is a working tool for a 250–300 seat F&B outlet and the customers in it. The Base Theme
is deliberately quiet: white page, warm greys from a single family, near-black ink, and one
default accent hue (petrol, §2 Brand) that a Tenant Theme replaces with its own. Color appears
only to carry meaning (action, status, timer) or the accent, within the accent budget. It must
work in sunlight on a phone at the table, on a greasy kitchen tablet, and on a finance
dashboard read for hours.

- **Default:** light theme on pure white `#ffffff`. Full dark theme via `.dark` on `<html>`
  (class) or the OS setting when the user chooses "Ikuti perangkat"; choice persists in
  `localStorage["legend-theme"]`.
- **Three densities** (PRD), set with `data-density` on a subtree via `<ThemeScope>`:

| Density         | `data-density`     | Used for                                           | Feel                                                                       | Control height         | Body                        |
| --------------- | ------------------ | -------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- | --------------------------- |
| Hangat & Visual | `hangat` (default) | QR order, member, shower, WFC, website, HRIS       | photo-led, rounded, pill CTAs, white page                                  | 48px (sm 44, lg 56)    | 16px Plus Jakarta Sans      |
| Kontras Tinggi  | `kontras`          | POS, captain order, KDS, expo, pickup, papan bilik | hard black/white, 2px lines, dark kitchen mode                             | 60px (sm 56, lg 64)    | 18px Plus Jakarta Sans      |
| Padat & Presisi | `padat`            | management, owner, shareholder, finance            | Metoric layering: canvas work area, double-shell cards, dense quiet tables | 36px mouse, 44px touch | 16px, table data 14px (PJS) |

Pattern references are for flow, layout, and density only — never another brand's colors,
logo, type, or signature elements (PRD "Batas referensi", D42, R26).

### v3 direction in one paragraph

v2 gave Legend _systems_ (accent ramp, surface ladder, type scale, photo-first cards). v3 gives
it one coherent _look_, taken from Metoric: work areas sit on a warm canvas (`surface-2`); big
cards are **double shells** — an 18px outer shell one tone off the canvas with 8px padding around
a 12px inner card; resting cards, shells, fields, and outline buttons carry a 1px hairline
shadow under a soft border; one type family everywhere (Plus Jakarta Sans, self-hosted) with
700-weight titles and figures, 26px page titles, 21px card titles, and uppercase +0.09em
labels; status badges are pills with icon + text; tables are sentence-case, 16px-padded, with
no header band; tab groups are bordered tracks with a card chip for the active tab. Legend's
petrol accent, warm dark ladder, and every v2 behavioural decision stay.

### Decision log

- **v2 owner decisions (2026-11-02, review `docs/design/design-v2-review.html`):** accent
  scarce — one filled accent area plus at most two accent details per viewport (Q21);
  borderless photo-first menu cards (Q22); **every menu item has a photo** — no placeholder art,
  a skeleton while loading, and a "Foto wajib" state in back office; the menu contract refuses
  publishing without one (Q23); Unsplash sample photos only in mock/demo data (Q24); urgent ops
  state = solid pill + thick start rule (Q25); late KDS ticket = full red header (Q26); occupied
  table = warm grey (Q27); grouped management sidebar 256px + 64px icon rail (Q28); selected row
  = accent tint + start rule (Q29); related metrics in one stat strip (Q30); the Base Theme gets
  a default hue (Q31); warm dark ladder (Q32).
- **v3 owner request (2026-11-02):** "Front end kita rombak lagi gunakan ini (DesainPakeAI
  project), colour palette sesuaikan dengan yang kita buat tadi" — Metoric visual language,
  Legend palette. Metoric purple `#7a5af8` never appears.
- **v3 coordinator decision (2026-11-02, Opus review of legend-ujxl):** the KDS bump action
  ("Selesai") is a full-width **neutral** (`secondary`) button, not primary: a board shows many
  tickets, and a primary per ticket would break the one-accent rule (Q21).

## 2. Color Palette & Roles

Tokens are CSS custom properties in `apps/web/src/styles/tokens.css`, mirrored in
`packages/shared/src/theme/base.ts`. A test fails if the two drift. Names are roles, never
values. Use the Tailwind class (`bg-primary`, `text-muted-foreground`, …), never a hex.

### Neutrals

| Role            | Token / class                          | Light     | Dark      | Use                                                                    |
| --------------- | -------------------------------------- | --------- | --------- | ---------------------------------------------------------------------- |
| Page (step 1)   | `background`                           | `#ffffff` | `#0f0e0d` | page, topbars, field fill                                              |
| Text            | `foreground`                           | `#1c1b19` | `#f3f1ee` | body text, icons                                                       |
| Surface         | `card` (`bg-card`, alias `bg-surface`) | `#ffffff` | `#1b1a18` | cards (inner card of a shell), popovers, sheets                        |
| Canvas (step 2) | `surface-2`                            | `#f7f6f4` | `#161513` | management/ops work area, customer bands, tab track, row hover         |
| Shell (derived) | `shell`                                | `#fbfaf9` | `#181715` | v3: outer layer of a double-shell card, management sidebar, ops topbar |
| Raised (step 3) | `surface-3`                            | `#f1efec` | `#242220` | occupied table, neutral badge, skeletons, media gaps, avatar chip      |
| Muted surface   | `muted`                                | `#f5f4f2` | `#211f1d` | disabled fields                                                        |
| Hint text       | `muted-foreground`                     | `#5f5b55` | `#aaa59d` | secondary text, labels, captions (AA on every surface incl. shell)     |
| Secondary fill  | `secondary`                            | `#f0eeeb` | `#2a2825` | secondary button (KDS "Selesai")                                       |
| Hover/selected  | `accent`                               | `#efedea` | `#2c2a27` | hovered menu item (shadcn meaning)                                     |
| Divider         | `border`                               | `#e8e5e1` | `#2f2c29` | v3: softer hairline for cards, shells, tables, outline buttons         |
| Field edge      | `input`                                | `#8a857d` | `#7c776f` | input/select/checkbox borders (≥3:1, WCAG 1.4.11)                      |
| Focus           | `ring`                                 | `#0f5e68` | `#5ec2cc` | v3: the accent, 2px outline + 2px offset (fields: accent edge + halo)  |

**Layering (v3, Metoric).** `background` (white) → `surface-2` canvas → `shell` → `card`.
`shell` is **derived** (`color-mix(in srgb, surface-2 55%, card)`, `DERIVED_TOKENS.shell`), so it
follows any theme island; it is neutral and not tenant-overridable. Light reads
`#f7f6f4 → #fbfaf9 → #ffffff`; the **warm dark ladder** reads page `#0f0e0d` → canvas `#161513`
→ shell `#181715` → card `#1b1a18`: lighter means closer, borders carry the edge, shadows are
not relied on. Kontras dark (dapur gelap) uses `#000000` → `#0b0a0a` → `#121110` → `#1c1b19`.
Never stack more than one step per region except the shell → card pair.

### Brand (Tenant Themes override these)

| Role             | Token                            | Light                 | Dark                  | Use                                                        |
| ---------------- | -------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------- |
| Main action      | `primary` / `primary-foreground` | `#0f5e68` / `#ffffff` | `#5ec2cc` / `#04262a` | the one primary CTA per view, links, checked controls      |
| Supporting brand | `brand` / `brand-foreground`     | `#3d3a35` / `#ffffff` | `#d9d5cf` / `#1c1b19` | tenant's "warna pendukung": tier cards, secondary emphasis |
| Brand tint       | `brand-subtle`                   | `#f3f1ee`             | `#262421`             | quiet brand backgrounds with `foreground` text             |

**Base Theme default hue (owner Q31): petrol** — light `#0f5e68` (7.4:1 on white, white text
7.4:1), dark `#5ec2cc` with `#04262a` text (9.2:1 on the dark page). Hue ~187°: far from the
Cafe Legend copper placeholder (~20°), from the status hues, and outside the indigo/violet range
that reads as generic AI UI (Metoric's `#7a5af8` is replaced, never used).

### Accent ramp — derived, not configured

One accent per tenant. Everything else is **mixed from `primary`** in CSS (`color-mix(in srgb,
…)`, `tokens.css`) and the same sRGB mix in TypeScript (`DERIVED_TOKENS`, `derivePalette`), so
the contrast gate checks exactly what renders and a Tenant Theme gets the ramp for free.

| Token / class         | Mix                                     | Use                                                                       |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `primary-hover`       | 88% primary into background             | hover of filled primary buttons                                           |
| `primary-tint`        | 10% primary into background             | selected nav row, selected table row, active bottom-nav pill, accent chip |
| `primary-tint-strong` | 18% primary into background             | stronger accent wash (accent label background)                            |
| `shadow-primary`      | 0 1px 2px, 35% primary into transparent | v3: the primary button's tinted hairline (Metoric)                        |
| `shadow-focus`        | 0 0 0 3px, 16% primary into transparent | v3: field focus halo (with `border-primary`)                              |
| `chart-accent`        | = primary                               | the one highlighted series                                                |
| `chart-neutral`       | 55% foreground into background          | comparison series, axis baseline (≥3:1 on cards)                          |
| `chart-grid`          | = border                                | horizontal gridlines only                                                 |

**Accent budget (per viewport, Q21):** one filled accent surface (the primary CTA, or the cart
bar) plus at most two accent details (active nav, one accent badge or link). Tabs, filters, and
segmented controls select in **ink** (card chip on the `surface-2` track), never in accent.
Empty-state glyphs, skeletons, media gaps, and the brand mark stay neutral.

### Status (fixed across tenants so meaning never changes)

v3 re-derives the four statuses toward Metoric's hues (green ~145°, amber ~38°, red ~358°,
blue ~220°) while keeping every pair AA. The solid color is also AA as text on `background`,
`card`, `surface-2`, and its own tint; the tint carries `foreground` text at ≥13:1.

| Status                            | solid / on-solid / tint (light)   | solid / on-solid / tint (dark)    |
| --------------------------------- | --------------------------------- | --------------------------------- |
| `success`                         | `#147a41` / `#ffffff` / `#e4f5eb` | `#55c98a` / `#05251a` / `#14291d` |
| `warning`                         | `#8f5800` / `#ffffff` / `#fcf1dc` | `#f0b04f` / `#2a1803` / `#2f2513` |
| `danger` (= shadcn `destructive`) | `#c02c31` / `#ffffff` / `#fdebeb` | `#f5787c` / `#2b0805` / `#361a1a` |
| `info`                            | `#245bd1` / `#ffffff` / `#e9f0fd` | `#82a9f5` / `#0a1a33` / `#18233a` |

Status colors never decorate: no status hue on actions, icons-for-flavor, or charts other than
a status meaning. A delta's color follows business meaning, not arrow direction (fewer returns
= success).

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

`packages/shared/src/theme/contrast.ts` checks 53 foreground/background pairs per mode (106
total; v3 adds text, hint, and link on `shell`) against WCAG 2.2 AA: 4.5:1 text, 3:1 field
borders and focus ring. Base, Kontras, and every Tenant Theme must pass in **both** modes;
`buildTenantThemeCss` refuses a failing theme and the Base Theme stays active (PRD: "tema yang
gagal tidak dapat diaktifkan"). A component that puts a token on a new surface adds that pair to
`REQUIRED_PAIRS`.

## 3. Typography Rules

| Family                     | Token / class                       | Where                                                             |
| -------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Plus Jakarta Sans Variable | `font-ui` (Kontras, Padat), fixed   | v3: operations and management — one family everywhere (Metoric)   |
| Plus Jakarta Sans Variable | `font-brand` (Hangat), tenant-owned | customer and brand surfaces; a tenant may pick from `BRAND_FONTS` |
| System mono                | `font-mono`                         | order codes, token names                                          |

Fonts are self-hosted (`@fontsource-variable/*`, imported in `globals.css`), so they load from
the edge node when the internet is down — never Google Fonts at runtime. Inter stays bundled
only as a tenant `BRAND_FONTS` option (`@font-face` downloads only when used).

v3 type scale. Steps are `type-*` utilities (`globals.css`) that set size, line height,
weight, and tracking together; color stays a separate class. They are named `type-*`, not
`text-*`, so `cn` never drops a color (see the gotcha below). Titles and figures are **700 with
negative tracking** (Metoric); size and weight carry hierarchy together.

| Step          | Class                | Size / line · weight · tracking      | Use                                                     |
| ------------- | -------------------- | ------------------------------------ | ------------------------------------------------------- |
| Display 2XL   | `type-display-2xl`   | 40→56 / 1.07 · 700 · −0.03em (fluid) | website and customer hero, one per page                 |
| Display XL    | `type-display-xl`    | 32→40 / 1.1 · 700 · −0.025em (fluid) | customer page title ("Menu"), design board titles       |
| Display       | `type-display`       | 26/32 · 700 · −0.02em                | page title in management/ops topbars (Metoric 26)       |
| Title         | `type-title`         | 21/28 · 700 · −0.015em               | card/table title, section heading, sheet item name, KDS |
| Heading       | `type-heading`       | 17/24 · 600 · −0.01em                | small card, panel, option-group headings                |
| Body          | inherited            | 16 (18 Kontras) / 24                 | all running text — do not set it                        |
| Small         | `text-sm`            | 14/20                                | hints, table headers, nav items                         |
| Eyebrow       | `type-eyebrow`       | 12/16 · 600 · +0.09em · uppercase    | KPI/card labels, nav group labels (Metoric label)       |
| Micro         | `text-xs`            | 12/16                                | badges, counters only                                   |
| Money display | `type-money-display` | 26/32 · 700 · −0.02em · tabular      | stat values, cart/sheet totals (`<Money size="stat">`)  |
| Money hero    | `type-money-hero`    | 44/48 · 700 · −0.03em · tabular      | the one big amount on a payment screen (`size="hero"`)  |

- **Money tiers:** `<Money size="stat" | "hero">` renders the `Rp` prefix at 0.6em in
  `muted-foreground`, raised, so the figure carries the weight; `inline` sizes stay as before.
  Right-aligned in tables (`numeric`), true minus `−`, always `tabular`.
- **Weights:** 400 body, 500 labels/nav/table headers, 600 buttons/badges/headings, 700
  titles/figures/wordmark. Nothing outside 400–700.
- **Numbers:** every amount, count, time, and code uses `tabular`. Money is always
  `<Money amount={…} />` (→ `formatRupiah`: `Rp 25.000`, no-break space, minus `−`).
- Body is inherited. To size something "like body" explicitly use
  `text-(length:--density-text)` (or `--density-text-data` for table data). **Never** add a
  `text-<customname>` font-size class: `cn` (tailwind-merge) reads it as a color and silently
  drops the real text color.
- Base text is 16px minimum for reading (PRD Kemudahan pakai) — Metoric's 14.5/15px body is not
  adopted; its 13.5–14.5 sizes map to `text-sm` for meta, headers, and nav only.

## 4. Component Stylings

All components live in `apps/web/src/components/ui` (shadcn/ui pattern on Radix, owned in
repo). Search there before creating anything; extend with a variant, never fork per screen.

| Component                 | File                         | Notes                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                    | `button.tsx`                 | variants `default` (primary, `shadow-primary`), `brand`, `secondary`, `outline` (card fill, soft `border`, `shadow-hairline`), `ghost`, `destructive`, `link`; sizes from density; `loading` = spinner + `aria-busy`. One `default` button per view.           |
| Input, Textarea           | `input.tsx`, `textarea.tsx`  | `fieldClass`: `input` edge (≥3:1), `rounded-field`, `shadow-hairline`; focus = `border-primary` + `shadow-focus` halo; 2px danger border when `aria-invalid`                                                                                                   |
| Select                    | `select.tsx`                 | Radix Select; trigger is a field; popover `rounded-lg shadow-overlay`                                                                                                                                                                                          |
| Checkbox, Switch          | `checkbox.tsx`, `switch.tsx` | size from `--check-size` (16/20/28px); checked = `primary` (Metoric's pale on-track fails 3:1); pair with `<Label htmlFor>`                                                                                                                                    |
| Label                     | `label.tsx`                  | 14px semibold                                                                                                                                                                                                                                                  |
| FormField                 | `form-field.tsx`             | label + control + hint + error; wires `id`, `aria-describedby`, `aria-invalid`, `aria-required`; error via `aria-live`; "(opsional)" marks optional fields. `fieldErrors(zodError)` maps Zod errors. Every error says how to fix it.                           |
| Dialog                    | `dialog.tsx`                 | bottom sheet on phones (`rounded-t-sheet`), centered `rounded-shell` from `sm`; focus trap, Escape, focus returns                                                                                                                                              |
| Sheet                     | `sheet.tsx`                  | right/left/bottom panel (cart, filters, mobile nav)                                                                                                                                                                                                            |
| DropdownMenu              | `dropdown-menu.tsx`          | `destructive` items are red text; confirm destructive actions in a Dialog                                                                                                                                                                                      |
| Tabs                      | `tabs.tsx`                   | v3 tab group: bordered `surface-2` track, `rounded-control`; active tab = card chip + hairline ring, semibold ink (never accent); arrow keys. Page sub-nav of router links uses the same look via `tabsListClass` / `tabsTriggerClass` + `aria-current="page"` |
| SegmentedControl          | `segmented-control.tsx`      | 2–4 options, same track/chip look as Tabs; radio-group semantics                                                                                                                                                                                               |
| Table                     | `table.tsx`                  | v3: no header band; header `text-sm font-medium muted` sentence case; cells `px-4 py-2.5`, `h-row` min; row hover `surface-2`; selected = `primary-tint` + 2px start rule (Q29); `numeric` right-aligned tabular                                               |
| DataTableShell            | `data-table-shell.tsx`       | v3 double shell: shell → inner card with toolbar (`type-title`, search field, actions), table, pager (row count left, page + 36–44px buttons right). Owns **loading / empty / no-results / error**.                                                            |
| Card                      | `card.tsx`                   | v3: `rounded-container` (12px), 1px `border`, `bg-card`, `shadow-hairline`, `p-card`; `type-heading` title (use `type-title` for big cards)                                                                                                                    |
| CardShell                 | `card.tsx`                   | v3 double shell: `rounded-shell` (18px) `bg-shell` border + 8px padding around one inner `Card` or `CardShellBody`; optional `CardShellFooter` on the shell (source link, period). The only allowed nesting.                                                   |
| Badge, StatusPill         | `badge.tsx`                  | v3: always pills. Badge = short label/count (tint + strong text, `neutral` on `surface-3`). StatusPill = status with **icon + text**, never color alone; `solid` only for the one state needing action now (late, waiter call; Q25)                            |
| StatusBand                | `status-band.tsx`            | full-width ticket header band (legend-ujxl) in the timer state; the band is the status: late = solid `danger` with the state in words (Q26), near = `warning-subtle`, on track = `surface-3`; table, order code (mono), channel, elapsed (tabular)             |
| Toast                     | `toast.tsx`                  | `useToast()({ title, description, tone })` confirms finished actions only; errors the user must fix stay next to the field                                                                                                                                     |
| Skeleton                  | `skeleton.tsx`               | shaped like the content; the region sets `aria-busy` + sr-only "Memuat…"                                                                                                                                                                                       |
| EmptyState, ErrorState    | `feedback-state.tsx`         | v3 glyph tile: 48px `rounded-container` on `bg-shell` with hairline (Metoric icon tile); error tile on `danger-subtle`; title + one-sentence hint + one next action; ErrorState `role="alert"` + "Coba lagi"                                                   |
| StatTile, StatStrip       | `stat-tile.tsx`              | label `type-eyebrow`, value `type-money-display`, period, **source link** (PRD). Related metrics go in one `StatStrip` (Q30): a double shell whose inner card is split by hairlines (1 / 2 / `columns`). No decorative deltas or sparklines.                   |
| Money, NumberDisplay      | `money.tsx`                  | `<data value>` + tabular figures; sizes `stat` / `hero` scale the `Rp` prefix (§3)                                                                                                                                                                             |
| MediaPlate                | `media-plate.tsx`            | Photo only (Q23): locked aspect (`card` 1:1, `hero` 3:2, `thumb` 4:5), `rounded-media` 12px, lazy `<img>` behind a skeleton; `missing="required"` ("Foto wajib", back office); overlay slots `topStart` / `topEnd` / `bottomEnd`; `muted` for sold out         |
| QrCode                    | `qr-code.tsx`                | the only QR renderer (`uqr`, legend-9fmm): one SVG path, `<title>` name, always-light plate so codes scan                                                                                                                                                      |
| ThemeSwitcher, ThemeScope | `components/theme-*.tsx`     | Terang / Gelap / Ikuti perangkat; ThemeScope sets `data-density` / `data-theme` / `data-tenant` on a subtree and portals overlays into it                                                                                                                      |

**States, defined once:** default · hover (`surface-2` or `primary-hover`) · focus-visible
(global 2px `ring` outline, 2px offset; fields: accent edge + halo) · pressed (`pressable`) ·
disabled (50–60% opacity, no pointer) · loading (`aria-busy`, spinner) · invalid
(`aria-invalid`, danger border + message) · selected row (tint + rule).

### Media and the photo-first card

Customer surfaces lead with photos (v2, unchanged in v3):

- **Menu card:** `MediaPlate ratio="card"` (1:1), status badge top-left on the photo, round add
  button bottom-right (40px, `bg-card shadow-card`, `aria-label="Tambah <nama>"`), then name
  (semibold, 2 lines max), one-line description (`text-sm muted`), price (`<Money>` semibold).
  No card border or padding — the plate is the container (Q22). Metoric's thumbnail-in-a-row
  product style is for back-office lists only.
- **Carousel card:** `ratio="thumb"` (4:5), 148px wide, inside a `surface-2` band.
- **Item sheet:** full-bleed `ratio="hero"` photo, round close/favorite on the photo, then
  badges, `type-title` name, description, `<Money size="stat">`.
- **Cart / list thumb:** 72px square plate; back-office table thumb 40px `rounded-md`.
- **Photo required (Q23):** skeleton while loading, never a letter tile or placeholder art; back
  office shows `MediaPlate missing="required"` next to the upload action.
- **Sold out:** photo `muted`, `Habis` badge, no add button, text muted.
- **Text on a photo** only with `scrim` (`--scrim-media`); prefer text below the photo.
- **Sample photos (Q24):** Unsplash License images only in mock/demo data under "Contoh data"
  (`apps/web/public/sample/menu/`).

### Empty and loading

Skeletons mirror the content shape. Empty states carry a functional glyph tile, one sentence,
and one next action. No decorative illustration.

Platform-specific components named in the PRD (table status card/map, KDS ticket with timer,
shower access ticket, Wi-Fi quota meter, member tier card, approval card, Tanya AI answer with
sources) are built per workstream **from these primitives and tokens**.

## 5. Layout Principles

**Spacing:** Tailwind 4px scale (`1`=4px … `16`=64px); Metoric's 8/12/16/20/28 steps are `2`,
`3`, `4`, `5`, `7`. Density-driven names: `h-control`, `h-control-sm`, `h-control-lg`,
`px-control-x`, `h-row`, `p-card`, `px-gutter`, `size-check`, `size-icon`. Section gap in
management = `gap-5` (20px, Metoric).

**Radius:** every radius is a multiple of `--radius-unit` (4px; tenants: tegas 2px, lembut 4px,
bulat 6px): `rounded-xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `2xl` 24 · `rounded-full`.
Intents (use these names):

| Intent              | Units (base px)     | Use                                                               |
| ------------------- | ------------------- | ----------------------------------------------------------------- |
| `rounded-control`   | pill / 2 / 2.5 (10) | buttons, tab/segment tracks: pill Hangat, 8px Kontras, 10px Padat |
| `rounded-field`     | 3 / 2 / 2.5         | inputs, selects, textareas                                        |
| `rounded-media`     | 3 (12)              | photos, thumbs, their skeletons; never pill                       |
| `rounded-container` | 3 (12) — v3         | cards, the inner card of a shell, glyph tiles                     |
| `rounded-shell`     | 4.5 (18) — v3       | outer double shell, dialogs from `sm`                             |
| `rounded-sheet`     | 6 (24)              | bottom sheets (`rounded-t-sheet`)                                 |

Pills (`rounded-full`): badges, status pills, chips, search pills and steppers in Hangat, cart
bar, avatar. Aspect locks: `aspect-card` 1:1, `aspect-hero` 3:2, `aspect-thumb` 4:5.

**App shells** (`apps/web/src/components/shells/`):

| Shell             | Density | Structure                                                                                                                                                                                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomerShell`   | hangat  | white header (tenant name `type-title` or logo + context "Meja 12 · 3 tamu"), one white column `max-w-2xl`, bottom nav ≤5 items (64px, safe-area), active item = `text-primary` + `primary-tint` pill behind the icon                                      |
| `OperationsShell` | kontras | full screen; status bar on `bg-shell` (screen `type-title`, outlet · station, connection pill, outlet clock in its time zone); work area owns the rest; `mode="dark"` for kitchen                                                                          |
| `ManagementShell` | padat   | sidebar on `bg-shell`: 256px grouped from 80rem shell width, 64px icon rail from 64rem, Sheet below; topbar 64px on `background` with `type-display` title (21px below 48rem), actions, initials chip; work area on `surface-2` canvas (container queries) |

**Frames:** the public brand website (`/`, `/menu`, `/reservation`, `/member`) is a photo-led
marketing site in a wide `max-w-6xl` frame (`SiteFrame`); the signed-in customer app keeps its
`max-w-2xl` column (`CustomerShell`).

### Per-area guidance (v3)

**Customer (Hangat) — white page, band rhythm.** The page stays white (owner rule; Metoric's
grey canvas is not used on customer pages). White top (title, search pill on `surface-2`, ink
filter chips) → one `surface-2` band for a featured carousel → white category sections with
photo-first grids → cart bar floats bottom (`bg-primary`, `rounded-full`; the page's one filled
accent). Grouped info (points, tier, bill summary) uses `Card`; a big summary may use
`CardShell`. Labels above figures use `type-eyebrow`. An ink band (`<ThemeScope mode="dark">`)
is allowed **once** per page for a ceremony moment. Bottom nav: max 5 items; the rest behind
"Lainnya". QR: `QrCode` only.

**Operations (Kontras) — status hierarchy (Q25–Q27).** Status bar on `shell`, work area on the
page tone. "Perlu tindakan" strip first (solid pill for the urgent count, tints for the rest).
Zones/stations are a `SegmentedControl` or `Tabs` group with counts — never accent-filled chips.
Table tiles (`rounded-container`): empty = card + border; occupied = `surface-3`, no border
(warm grey, Q27); **urgent** = solid status pill + 2px border + 6px start rule in the status
color; calm attention = tint pill on `surface-3`; cleaning = dashed border; inactive =
`surface-2`, muted. Table code 30/36 bold.

**KDS (Kontras, dark only).** `OperationsShell mode="dark"`. Tickets `rounded-container`,
`border-(length:--border-w) bg-card`, with a **StatusBand** header: late = full solid `danger`
band with the state in words (Q26), near = `warning-subtle`, on track = `surface-3`; table,
order code (mono), channel, elapsed time (30px tabular); quantities in 44px `surface-3` squares;
critical modifiers ("Tanpa gula") as a warning flag. Bump = full-width **`secondary`
"Selesai"** (neutral; never primary on a multi-ticket board, §1 decision log).

**Management (Padat) — Metoric layering (Q28–Q30).** Canvas `surface-2` work area, page
pattern: topbar title → toolbar (tab group + actions) → content with `gap-5`. Dashboard order:
"Perlu perhatian" (each row with its action) → one **StatStrip** (double shell, hairline cells,
period + source link each) → chart in a `CardShell` → tables in `DataTableShell`. Feature pages
must not add their own outer gutter or a second page title (the topbar owns it). Sidebar groups
come from `features/<ws>-<name>/nav.ts` (`group: "operations" | "finance" | "team"`,
`NAV_GROUPS` in `lib/areas/nav.ts`). Selected nav = `primary-tint` + 2px `primary` start rule

- semibold `text-primary`.

Routes pass `nav` items with `current` from the router and a `LinkComponent` wrapping the
router `Link`. Shells render `<main id="main-content">` (skip link target).

**Responsive:** 360px to ≥1440px (PRD). Mobile first. No horizontal page scroll at any width;
wide tables scroll inside their container with the key column first; dialogs become bottom
sheets on phones; primary actions stay in thumb reach.

**Gotcha:** an implicit `grid` sizes its column to max-content. Any grid holding tables,
truncated text, or long rows needs `grid-cols-[minmax(0,1fr)]` (or explicit columns) and
`min-w-0` on flex children, or it overflows on phones.

## 6. Depth & Elevation

Flat. Separation comes from surface tone (layering) and 1px `border`; v3 adds Metoric's
hairline shadow under resting borders.

| Level    | Class                       | Use                                                                                 |
| -------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Hairline | `shadow-hairline`           | v3: resting cards, shells, fields, outline buttons, tab chip (0 1px 2px, 4% ink)    |
| Primary  | `shadow-primary`            | v3: the primary button only (accent-tinted 0 1px 2px)                               |
| Raised   | `shadow-raised`             | badges on photos, draggable items                                                   |
| Card     | `shadow-card`               | interactive lift only — hovered card, floating add button, cart bar, sticky summary |
| Overlay  | `shadow-overlay` + `border` | menus, select popovers, dialogs, sheets, toasts — the only large shadow             |
| Scrim    | `bg-scrim`                  | behind dialogs/sheets                                                               |

Order of preference: **tone** → **hairline border** → **hairline shadow** → shadow only for
something that floats or responds. Hover is a tone change (`surface-2`), not a new elevation.
In dark mode shadows barely read, so every layer keeps its border.

## 7. Motion

| Token                      | Value                                               | Use                                   |
| -------------------------- | --------------------------------------------------- | ------------------------------------- |
| `--duration-fast`          | 120ms                                               | hover, press, color changes           |
| `--duration-base`          | 200ms                                               | menus, toasts, popovers               |
| `--duration-slow`          | 320ms                                               | sheets, dialogs                       |
| `ease-standard`            | `cubic-bezier(0.2,0,0,1)`                           | default                               |
| `ease-enter` / `ease-exit` | `cubic-bezier(0,0,0,1)` / `cubic-bezier(0.3,0,1,1)` | entering / leaving                    |
| `ease-sheet`               | `cubic-bezier(0.32,0.72,0,1)`                       | sheets, cart bar enter (no overshoot) |
| `pressable` utility        | scale `--press-scale` 0.97 on `:active`, fast       | buttons, tappable cards, add buttons  |

Micro-interactions: press scale on every tappable element; sheets enter with `ease-sheet` over
`--duration-slow` and a 12px rise; the cart bar slides up once on the first add; the cart count
pops once; money totals may count up over 240ms (money only). Motion only communicates state,
continuity, or feedback. Under `prefers-reduced-motion: reduce` every duration becomes 0 and
`motion/react` honors it via `MotionConfig reducedMotion="user"`.

## 8. Do's and Don'ts

**Do**

- Use tokens and shared components only; if something is missing, add a token or variant here
  first (one place), then use it.
- Keep customer pages white in light mode; put management work areas on the `surface-2` canvas
  with big cards in a `CardShell` / `StatStrip` / `DataTableShell`.
- Show every list's loading, empty, and error state (PRD); give every error a fix hint.
- Pair every status color with an icon and text.
- Use `<Money>` / `formatRupiah` for every amount and `tabular` for every number column.
- Put all UI text in `packages/shared/src/i18n/messages/id.ts` and read it with `useT()`.
- Label sample content as "Contoh data" and keep it out of shipped screens.

**Don't**

- No raw colors (hex, `rgb()`, `bg-white`, `text-black`) outside `tokens.css` —
  `node scripts/ci/color.mjs` fails the build. Never Metoric purple.
- No tenant-specific code or branches on tenant id/name/domain (R27).
- No gradients for decoration (incl. Metoric's gradient avatar and chart fills), glassmorphism,
  glow, emoji icons, decorative illustrations, bento grids, or fake app mockups.
- No invented numbers, ratings, testimonials, people, urgency, or business rules; no lorem.
- No cards inside cards except the shell → card pair; no large shadow on resting surfaces; no
  second primary button in a view; no accent fill on chips, tabs, or station filters.
- No `text-<customname>` size classes; no `dark:` overrides where a token already switches.
- No second font family; no weights outside 400–700; no Google Fonts at runtime.
- No letter tiles or placeholder art for missing photos.

## 9. Theming (two layers)

1. **Base Theme** — this file + `tokens.css`. Light on `:root`, dark on `.dark` / `[data-theme="dark"]`.
2. **Tenant Theme** — a `TenantThemeConfig` object (from tenant settings, filled by Super Admin):
   `colors.light/dark` for `primary`, `primary-foreground`, `brand`, `brand-foreground`,
   `brand-subtle`, `muted`, `secondary`, `accent`; `font` from `BRAND_FONTS` (customer
   surfaces); `corners` (`tegas`/`lembut`/`bulat`, scales every radius incl. the 12/18 shell
   pair); `logoUrl`. `buildTenantThemeCss(config)` validates it (AA in both modes, safe id) and
   emits a CSS layer scoped to `[data-tenant="<id>"]`. Status colors, neutrals (incl. `shell`),
   the focus ring, and the ops/management font are not overridable. Files: `themes/<tenant>.md`.

The theme preference script runs before first paint (`ThemeBootScript` in `Providers`), so
dark-mode users never see a white flash.

## 10. Data visualization

Management charts are quiet and answer one question each, inside a `CardShell` (title
`type-title`, eyebrow period above it, source link in `CardShellFooter`). One highlighted series
in `chart-accent` (2–2.5px line); comparison in `chart-neutral`; horizontal gridlines only in
`chart-grid` (dashed `3 6` allowed); a 1px `chart-neutral` baseline; axis labels `text-xs muted
tabular`; bars `rounded-t-[3px]`. No gradient area fills (Metoric's ≤16% fill is dropped: the
accent budget and "no decorative gradient" rule win). A legend only with two series. Empty chart
= the empty state, never an empty grid. Every chart has an `aria-label`. No decorative deltas
or sparklines; a delta appears only when the source provides one, as a `Badge` with icon + text
colored by business meaning.

## 11. Iconography

lucide only (Metoric's Iconify `lucide:*` set, same glyphs). Stroke **1.75** in Hangat/Padat,
**2** in Kontras (`globals.css` on `svg.lucide`). Sizes: 16 (inline, badges 14), 20 (nav,
default), 24 (Kontras, bottom nav). Icons sit next to a text label unless the control has an
`aria-label`. Active nav = tint behind the icon, not a filled glyph swap. Icons inside status
pills always pair with the word. No emoji, no sparkle/robot "AI" icons.

## 12. Agent Prompt Guide

Paste into any UI brief:

> Build this screen for Legend Super App using only the design system (DESIGN.md v3, open
> `/design-system`). Wrap it in the right shell (`CustomerShell` / `OperationsShell` /
> `ManagementShell`) — the shell sets density, the page title, and the gutter; do not add your
> own. Use `@/components/ui` and tokens by role (`bg-card`, `bg-shell`, `text-muted-foreground`,
> `bg-primary`, …) — no hex, no `bg-white`, no purple. Management: big cards in `CardShell`,
> metrics in one `StatStrip`, lists in `DataTableShell`, view switches with `Tabs`. Every amount
> uses `<Money>`; number columns `numeric`. Every list shows loading, empty, and error. Forms use
> `FormField` with fix-it errors. Text via `useT()`. Status is `StatusPill` (icon + text). One
> primary button per view. Check 390px and 1440px in light and dark, run
> `node scripts/ci/color.mjs` and `node scripts/ci/tenant-hardcode.mjs`.

Quick picks:

- Customer menu item: `MediaPlate` 1:1 with badge top-left and round add button bottom-right,
  then name `font-semibold line-clamp-2`, description `text-sm text-muted-foreground
line-clamp-1`, `<Money>` semibold. No card border or padding.
- KDS ticket: `OperationsShell mode="dark"`, `rounded-container border-(length:--border-w)
bg-card`, StatusBand header by timer state, table `type-title`, elapsed 30px tabular, qty
  squares on `surface-3`, full-width **`variant="secondary"`** "Selesai" (neutral, not primary).
- Dashboard: grouped sidebar, "Perlu perhatian" first, one `StatStrip` with source links, chart
  in a `CardShell`, `DataTableShell` table with a `Tabs` toolbar.

## 13. Metoric mapping (v3)

Source: DesainPakeAI project "Metoric Design System" v1.0.0 (revision
`sha256-efc4a730…010b`), read-only via the `dpai` CLI. What was taken, how it maps, and where
Legend wins.

| Metoric                                                      | Legend v3                                                                | Note                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `--color-primary` #7a5af8 / deep #6a48f0                     | `primary` petrol #0f5e68 / #5ec2cc, `primary-hover` derived              | **Conflict → Legend** (owner: keep palette; purple never appears)      |
| canvas #f6f6f8 / surface-subtle #fafafc / surface #fff       | `surface-2` #f7f6f4 / `shell` (derived) #fbfaf9 / `card` #fff            | Warm greys kept; layering adopted                                      |
| surface-raised #fbfbfc (sidebar, topbar)                     | sidebar + ops topbar `shell`; management topbar `background`             | Adopted                                                                |
| text / text-muted / border                                   | `foreground` / `muted-foreground` / `border` #e8e5e1 (softened)          | Adopted (warm)                                                         |
| text-subtle #9c9daa for labels                               | `muted-foreground`                                                       | **Conflict → Legend**: #9c9daa is ~2.7:1, fails AA                     |
| status success/warning/danger/info + bg                      | re-derived same hues, AA in light + warm dark (§2)                       | Metoric pairs fail AA as pill text; darkened                           |
| no dark mode                                                 | warm dark ladder (Q32), KDS dapur gelap                                  | Legend addition                                                        |
| Plus Jakarta Sans via Google Fonts                           | Plus Jakarta Sans self-hosted (`@fontsource-variable`) for every density | **Conflict → Legend**: no runtime CDN (offline edge node)              |
| type 12 / 13.5 / 14.5 / 15 / 21 / 26                         | eyebrow 12, `text-sm` 14, body 16, title 21, display 26                  | **Conflict → Legend**: body ≥16px (PRD Kemudahan pakai)                |
| weights 400–700, 700 for titles & figures                    | same                                                                     | Adopted                                                                |
| radius 8 / 12 / 18 / full; shell 18 + inner 12, padding 8    | `rounded-md` 8, `rounded-container` 12, `rounded-shell` 18; `CardShell`  | Adopted; still multiples of the tenant radius unit                     |
| buttons radius 12                                            | `rounded-control`: pill Hangat, 8 Kontras, 10 Padat                      | **Conflict → Legend** in Hangat (pill CTAs) and Kontras (60px targets) |
| shadow 0 1px 2px .02–.05; primary tinted shadow              | `shadow-hairline`, `shadow-primary`                                      | Adopted                                                                |
| search focus: accent border + 3px halo                       | fields: `border-primary` + `shadow-focus`; global focus = accent outline | Adopted; `ring` now the accent                                         |
| soft field border #e9e9f0                                    | field edge stays `input` (≥3:1)                                          | **Conflict → Legend**: WCAG 1.4.11                                     |
| sidebar 296px, active = grey pill + accent text              | 256px grouped + 64px rail (Q28), active = tint + start rule (Q29)        | **Conflict → Legend**                                                  |
| nav item 40px, radius 11, icon 20                            | same height, `rounded-control`, icon 20                                  | Adopted                                                                |
| topbar title 26 bold                                         | `type-display` in ManagementShell topbar                                 | Adopted                                                                |
| tab group: white track, active chip with inset ring          | `surface-2` track, card chip + ring                                      | Adopted, track toned for dark-mode legibility                          |
| 4 separate KPI shell cards with delta pill                   | one `StatStrip` double shell (Q30), no decorative deltas                 | **Conflict → Legend** (Q30, PRD source link)                           |
| status badge pill 12.5 semibold, icon 14 + text              | `Badge` / `StatusPill` pills, icon + text                                | Adopted                                                                |
| table: header 13.5 subtle, cells 13×16, hover, selected tint | `text-sm` medium header, `px-4 py-2.5`, `surface-2` hover, tint + rule   | Adopted; selected adds Legend's start rule (Q29)                       |
| toggle on = pale accent #c9b7fa                              | checked = `primary`                                                      | **Conflict → Legend**: pale track fails 3:1                            |
| chart area gradient ≤ .16                                    | no fill; accent line + neutral comparison                                | **Conflict → Legend**: no decorative gradient, accent budget           |
| avatar gradient                                              | initials chip on `surface-3`                                             | **Conflict → Legend**: no decorative gradient                          |
| thumbnail 36–46px gradient tile with icon                    | real photo (`MediaPlate`), "Foto wajib" when missing                     | **Conflict → Legend** (Q23)                                            |
| one primary per view; status never color alone               | same (Q21)                                                               | Already Legend                                                         |
