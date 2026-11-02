# DESIGN.md — Legend Super App · Base Theme

> Design System Platform, Base Theme (PRD v1.7 Kelompok A "Design System Platform", D42, R26).
> Every screen is built from these tokens and the shared component library. Read this file
> before any UI work. Tenant Themes override a small, checked subset: see `themes/`.
> Live reference: `/design-system` (all tokens, components, states, both modes, three
> densities, three app shells). Screenshots: `docs/design/screenshots/`.

<!-- ryux-context:start -->

- **UI direction**: Calm, warm-neutral, trustworthy task UI on a white background; brand color only where it carries meaning; status always as icon + text
- **Motion direction**: Quiet and functional — state changes and overlays only, 120–320ms, everything off under prefers-reduced-motion

<!-- ryux-context:end -->

## 1. Visual Theme & Atmosphere

Legend is a working tool for a 250–300 seat F&B outlet and the customers in it. The Base Theme
is deliberately neutral: white page, warm greys from a single family, near-black ink, and
no brand hue of its own. Color appears only to carry meaning (action, status, timer) or, in a
Tenant Theme, the tenant's brand. It must work in sunlight on a phone at the table, on a
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

## 2. Color Palette & Roles

Tokens are CSS custom properties in `apps/web/src/styles/tokens.css`, mirrored in
`packages/shared/src/theme/base.ts`. A test fails if the two drift. Names are roles, never
values. Use the Tailwind class (`bg-primary`, `text-muted-foreground`, …), never a hex.

### Neutrals

| Role           | Token / class                          | Light     | Dark      | Use                                                  |
| -------------- | -------------------------------------- | --------- | --------- | ---------------------------------------------------- |
| Page           | `background`                           | `#ffffff` | `#121110` | page and field fill                                  |
| Text           | `foreground`                           | `#1c1b19` | `#f3f1ee` | body text, icons                                     |
| Surface        | `card` (`bg-card`, alias `bg-surface`) | `#ffffff` | `#1a1917` | cards, popovers, sheets                              |
| Muted surface  | `muted`                                | `#f5f4f2` | `#23211f` | sidebar, disabled fields, skeleton                   |
| Hint text      | `muted-foreground`                     | `#5f5b55` | `#aaa59d` | secondary text, captions (AA on all surfaces)        |
| Secondary fill | `secondary`                            | `#f0eeeb` | `#2a2825` | secondary button                                     |
| Hover/selected | `accent`                               | `#efedea` | `#2c2a27` | hovered row/menu item, selected nav (shadcn meaning) |
| Divider        | `border`                               | `#e3e0dc` | `#33302c` | decorative separators only                           |
| Field edge     | `input`                                | `#8a857d` | `#78736b` | input/checkbox borders (≥3:1, WCAG 1.4.11)           |
| Focus          | `ring`                                 | `#1f5fbf` | `#7aaaf0` | the one focus indicator (2px outline, 2px offset)    |

### Brand (Tenant Themes override these)

| Role             | Token                            | Light                 | Dark                  | Use                                                        |
| ---------------- | -------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------- |
| Main action      | `primary` / `primary-foreground` | `#1c1b19` / `#ffffff` | `#f3f1ee` / `#1c1b19` | the one primary CTA per view, links, checked controls      |
| Supporting brand | `brand` / `brand-foreground`     | `#3d3a35` / `#ffffff` | `#d9d5cf` / `#1c1b19` | tenant's "warna pendukung": tier cards, secondary emphasis |
| Brand tint       | `brand-subtle`                   | `#f3f1ee`             | `#262421`             | quiet brand backgrounds with `foreground` text             |

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

`packages/shared/src/theme/contrast.ts` checks 37 foreground/background pairs per mode (74
total) against WCAG 2.2 AA: 4.5:1 text, 3:1 field borders and focus ring. Base, Kontras, and
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

| Step    | Class                                              | Size/line            | Use                                                   |
| ------- | -------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| Display | `text-3xl` / `sm:text-4xl`, bold, `tracking-tight` | 30/36 · 36/44        | one per page, page title on brand/customer pages only |
| Title   | `text-2xl font-semibold`                           | 24/32                | section heading, stat value                           |
| Heading | `text-xl` / `text-lg font-semibold`                | 20/28 · 18/28        | dialog and card headings, app bar title               |
| Body    | inherited from `[data-density]`                    | 16 (18 Kontras) / 24 | all running text — do not set it                      |
| Small   | `text-sm`                                          | 14/20                | hints, captions, table headers                        |
| Micro   | `text-xs`                                          | 12/16                | badges, counters only                                 |

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

| Component              | File                            | Notes                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                 | `button.tsx`                    | variants `default` (primary), `brand`, `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `default/sm/lg/icon/icon-sm` from density; `loading` shows spinner + `aria-busy` and blocks repeats. One `default` button per view.                                                                                  |
| Input, Textarea        | `input.tsx`, `textarea.tsx`     | `fieldClass`: `input` border, `rounded-field`, 2px danger border when `aria-invalid`                                                                                                                                                                                                                                      |
| Select                 | `select.tsx`                    | Radix Select; trigger looks like a field; popover `shadow-overlay`                                                                                                                                                                                                                                                        |
| Checkbox, Switch       | `checkbox.tsx`, `switch.tsx`    | size from `--check-size` (16/20/28px); always pair with a `<Label htmlFor>` that is the touch target                                                                                                                                                                                                                      |
| Label                  | `label.tsx`                     | 14px semibold                                                                                                                                                                                                                                                                                                             |
| FormField              | `form-field.tsx`                | label + control + hint + error; wires `id`, `aria-describedby`, `aria-invalid`, `aria-required`; error announced via `aria-live`; optional fields marked "(opsional)". `fieldErrors(zodError)` maps a Zod error to messages. Zod built-ins speak Indonesian (`z.config(z.locales.id())`). Every error says how to fix it. |
| Dialog                 | `dialog.tsx`                    | bottom sheet on phones, centered from `sm`; focus trap, Escape, focus returns to trigger                                                                                                                                                                                                                                  |
| Sheet                  | `sheet.tsx`                     | right/left/bottom panel (cart, filters, mobile nav)                                                                                                                                                                                                                                                                       |
| DropdownMenu           | `dropdown-menu.tsx`             | `destructive` items are red text; confirm destructive actions in a Dialog                                                                                                                                                                                                                                                 |
| Tabs                   | `tabs.tsx`                      | underline tabs, arrow-key navigation                                                                                                                                                                                                                                                                                      |
| Table                  | `table.tsx`                     | `h-row` rows, `numeric` cells right-aligned tabular; scrolls inside its container                                                                                                                                                                                                                                         |
| DataTableShell         | `data-table-shell.tsx`          | every list: title, search, actions, **loading / empty / no-results / error**, row count, pagination                                                                                                                                                                                                                       |
| Card                   | `card.tsx`                      | flat, 1px border, `rounded-xl`, `p-card`; no shadow; never nest cards                                                                                                                                                                                                                                                     |
| Badge, StatusPill      | `badge.tsx`                     | Badge = short label/count (tint + strong text). StatusPill = order/timer/status with **icon + text**, never color alone                                                                                                                                                                                                   |
| Toast                  | `toast.tsx`                     | `useToast()({ title, description, tone })` confirms finished actions only; errors the user must fix stay next to the field                                                                                                                                                                                                |
| Skeleton               | `skeleton.tsx`                  | shaped like the content; the region sets `aria-busy` + sr-only "Memuat…"                                                                                                                                                                                                                                                  |
| EmptyState, ErrorState | `feedback-state.tsx`            | icon + title + hint + next action; ErrorState has `role="alert"` and "Coba lagi"                                                                                                                                                                                                                                          |
| StatTile               | `stat-tile.tsx`                 | label, value, period, **link to source data** (PRD); no decorative deltas or sparklines                                                                                                                                                                                                                                   |
| Money, NumberDisplay   | `money.tsx`                     | `<data value>` + tabular figures                                                                                                                                                                                                                                                                                          |
| QrCode                 | `qr-code.tsx`                   | the only QR renderer (`uqr`, bead legend-9fmm): one SVG path, `<title>` as accessible name, always-light plate in both modes so codes scan; `size`, `margin` (quiet zone), `level`                                                                                                                                        |
| SegmentedControl       | `segmented-control.tsx`         | 2–4 options (theme, density, view); radio group semantics                                                                                                                                                                                                                                                                 |
| ThemeSwitcher          | `components/theme-switcher.tsx` | Terang / Gelap / Ikuti perangkat                                                                                                                                                                                                                                                                                          |
| ThemeScope             | `components/theme-scope.tsx`    | sets `data-density` / `data-theme` / `data-tenant` on a subtree **and** makes overlays portal into it                                                                                                                                                                                                                     |

**States, defined once:** default · hover (`accent` fill or `/90`) · focus-visible (global 2px
`ring` outline, 2px offset) · pressed · disabled (50–60% opacity, no pointer) · loading
(`aria-busy`, spinner) · invalid (`aria-invalid`, danger border + message).

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
`rounded-xl`, sheets `rounded-t-2xl`.

**App shells** (`apps/web/src/components/shells/`):

| Shell             | Density | Structure                                                                                                                                                             |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomerShell`   | hangat  | header (tenant name/logo + context like "Meja 12 · 3 tamu"), one scrolling column `max-w-2xl`, bottom nav (≤5 items, 64px, safe-area padding)                         |
| `OperationsShell` | kontras | full screen, status bar (screen, outlet · station, connection, outlet clock in its own time zone), work area owns the rest; `mode="dark"` for kitchen                 |
| `ManagementShell` | padat   | sidebar 240px + topbar 56px from 64rem shell width; below that the sidebar moves into a Sheet behind a menu button (container queries, so it adapts to its own width) |

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

| Level   | Class                       | Use                                             |
| ------- | --------------------------- | ----------------------------------------------- |
| 0       | —                           | page, cards, tables, stat tiles                 |
| Raised  | `shadow-raised`             | the selected segment, draggable items only      |
| Overlay | `shadow-overlay` + `border` | menus, select popovers, dialogs, sheets, toasts |
| Scrim   | `bg-scrim`                  | behind dialogs/sheets                           |

In dark mode shadows barely read, so overlays always keep their border.

## 7. Motion

| Token                      | Value                                               | Use                         |
| -------------------------- | --------------------------------------------------- | --------------------------- |
| `--duration-fast`          | 120ms                                               | hover, press, color changes |
| `--duration-base`          | 200ms                                               | menus, toasts, popovers     |
| `--duration-slow`          | 320ms                                               | sheets, dialogs             |
| `ease-standard`            | `cubic-bezier(0.2,0,0,1)`                           | default                     |
| `ease-enter` / `ease-exit` | `cubic-bezier(0,0,0,1)` / `cubic-bezier(0.3,0,1,1)` | entering / leaving          |

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

## 10. Agent Prompt Guide

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

- Customer menu item: `rounded-2xl border bg-card p-3`, name `font-semibold`, description
  `text-sm text-muted-foreground truncate`, `<Money>` semibold, `Button size="icon-sm"` "Tambah".
- KDS ticket: `OperationsShell mode="dark"`, `rounded-lg border-(length:--border-w) bg-card p-4`,
  table number `text-2xl font-bold`, `StatusPill status={timer}`, full-width primary "Selesai".
- Dashboard: `ManagementShell`, a row of `StatTile` each with a source link, then a
  `DataTableShell` table.
