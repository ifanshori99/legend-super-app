# Design references for Legend Super App

Research for the visual-quality upgrade (owner decision 2026-11-02, PRD **D42** and **R26**).

> **Scope.** Patterns only: layout, hierarchy, density, depth, motion, imagery discipline.
> Never another brand's colors, logo, type, or signature elements. Every "take" below is
> translated into Legend tokens/components — no reference hex value is proposed as a token.
>
> **Status.** Research only. This folder changes no app code and does not edit `DESIGN.md`.
> The upgrade moves in §7 are proposals for the next DESIGN.md revision.

- **Collected:** 2026-11-02
- **Source:** <https://getdesign.md> — DESIGN.md analyses fetched with the site's own CLI
  (`npx getdesign@latest add <brand>`) and the live preview pages (`/<brand>/design-md` → Preview)
- **Method:** full DESIGN.md text saved per brand, key sections trimmed into `<brand>/excerpt.md`,
  3–7 screenshots per brand of the live token/component catalog
- **Attribution:** analyses are by getdesign.md / VoltAgent, independent of the brands.
  Brands and marks belong to their owners. Reference use inside this repo only.

---

## 0. The short version

Legend's Base Theme is deliberately neutral: white page, warm greys, **near-black primary**
(`#1c1b19`), flat cards with a 1px border, one shadow tier reserved for overlays, max display
size 36px. That is why the UI reads plain — there is no color voltage, no surface ladder, no
image layer, and no type moment. The fix is not to paint Legend green or coral; it is to add
the _systems_ the references use to make neutral palettes look expensive:

| #   | Move                                                                                    | Kind                  | Impact |
| --- | --------------------------------------------------------------------------------------- | --------------------- | ------ |
| 1   | Apply the tenant accent for real (filled CTAs, active nav, one tinted surface per view) | token + component     | ★★★★★  |
| 2   | Photo-first menu/member cards (real media plates, badges, scrim)                        | component + tokens    | ★★★★★  |
| 3   | Three-step surface ladder + one interactive elevation                                   | token                 | ★★★★☆  |
| 4   | Expand the type scale and add display tracking/weight contrast                          | token                 | ★★★★☆  |
| 5   | Give customer pages a band rhythm (white → tint → ink)                                  | shell + section       | ★★★★☆  |
| 6   | Ops board: status hierarchy and tinted occupied tables                                  | component             | ★★★★☆  |
| 7   | Money/number display system (`tnum`, size tiers, currency scaling)                      | component             | ★★★☆☆  |
| 8   | Management shell: grouped sidebar, selected state, icon rail                            | shell                 | ★★★☆☆  |
| 9   | Radius/pill intent per density (media, container, control, sheet)                       | token                 | ★★★☆☆  |
| 10  | Empty/loading states: functional glyph, media skeletons                                 | component             | ★★★☆☆  |
| 11  | Micro-interaction pass: press scale, sheet spring, total count-up                       | motion token          | ★★★☆☆  |
| 12  | Dark mode: true dark ladder + alpha hairlines                                           | token                 | ★★★☆☆  |
| 13  | Imagery rules: aspect locks, scrim token, warm placeholder                              | token + component     | ★★★☆☆  |
| 14  | Data-viz style for management (2px lines, baseline only, one accent)                    | token + chart wrapper | ★★☆☆☆  |
| 15  | Iconography pass: 1.5px stroke, 20/24px, filled active state                            | icon rules            | ★★☆☆☆  |

Details, effort, risk, and the reference each move comes from: **§7**.

---

## 1. Reference index

| Reference     | Category                | Why it is here                                                            | Best Legend surface                   |
| ------------- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| **Starbucks** | café / retail           | The closest analogue: café ordering, rewards ceremony, product customizer | Customer QR order, member, item sheet |
| **Airbnb**    | hospitality marketplace | Photo-first cards and a single-accent marketplace                         | Customer menu, favorites, booking     |
| **Uber**      | mobility super-app      | Ops-grade contrast, pill geometry, polarity bands                         | POS, KDS, expo, table board           |
| **Linear**    | issue tracker           | Dense dark UI, surface ladder without shadows                             | Management (kelola), owner            |
| **Mercury**   | fintech / banking       | Quiet precision, light variable weights, tonal depth                      | Owner, finance, shareholder           |
| **Stripe**    | payments infrastructure | Money typography (`tnum`), tonal cards, dashboard chrome                  | Payments, finance, reports            |
| **Sentry**    | observability           | Two-polarity canvas, dense tables, one dominant CTA                       | Management, platform admin            |
| **Oura**      | wellness hardware       | Warm paper canvas, editorial serif + grotesque, earth-tone data-viz       | Member, shower/WFC, rewards           |
| **Wise**      | consumer fintech        | Friendly money UI, 24px card radius, semantic palette                     | Checkout, split bill, wallet          |
| **Shopify**   | commerce admin          | Two-track canvas: cinematic marketing, calm transactional                 | Kelola catalog, merchant-style admin  |
| **Notion**    | workspace               | Warm paper minimalism, one blue, decorative sticker discipline            | Management, CMS, T&C pages            |
| **Cal.com**   | scheduling              | Booking flow clarity, embedded real UI, monochrome CTAs                   | Reservation, waitlist, pickup slots   |

Full analyses: `<brand>/excerpt.md`. Screenshots: `<brand>/*.png`.

---

## 2. How to read the per-reference notes

Each reference gets the same nine attributes, because those are the levers that make a neutral
UI look premium:

1. **Spacing scale** — base unit, section rhythm, card padding
2. **Type scale & weights** — display sizes, tracking, weight contrast, tabular figures
3. **Surface layering / elevation** — how many surface steps, shadow or tonal lift
4. **Accent usage** — how much color, where, and what is deliberately left uncolored
5. **Imagery / illustration** — photo ratios, art direction, decorative vs functional
6. **Iconography** — stroke, size, active state
7. **Data-viz style** — chart grammar, number treatment
8. **Micro-interactions** — press, hover, transitions
9. **Empty states** — what the reference does when there is no content

Marketing-site analyses do not always document 6–9. Where the source is silent, the row says
**not documented** and gives the closest observable cue from the preview. Nothing is invented.

---

## 3. The seven PRD references

### 3.1 Starbucks — customer QR order, member, item sheet

**Why it reads premium.** A four-tier green system on a warm cream canvas, where every green has
a job (brand, CTA, dark band, decorative) and gold appears only for Rewards ceremony. The
restraint is the luxury: one color family, three typefaces with strict contexts, and pill
buttons everywhere.

**Signature move.** The floating circular "Frap" order button: 56px, bottom-right, two stacked
low-alpha shadows, `scale(0.95)` on press. It is the only elevated element on the page.

| Attribute          | What the reference does                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | rem scale anchored at 10px: 4 / 8 / 16 / 24 / 32 / 40 / 48 / 56 / 64. `16px` is the universal rhythm (card padding, gutter, body size). Gutters 16 → 24 → 40.                                                                                                               |
| Type               | SoDoSans, `-0.16px`/`-0.01em` tracking almost everywhere. H1 and H2 are both 24/36 — **weight and color** separate them (600 green vs 400 ink). Display tops out at 80px on Rewards. A serif (Lander Tall) is used only for Rewards headlines; a script only for cup names. |
| Surfaces           | Solid color blocks, no gradients. Page rhythm: cream hero → white content → deep green (`#1E3932`) feature band → cream utility → deep green footer. Depth = band polarity, not shadow.                                                                                     |
| Accent             | Four greens mapped to roles; gold reserved for status ceremony; red/yellow only for semantic states.                                                                                                                                                                        |
| Imagery            | Gift cards are photographed physical product, not generated graphics. PDP uses circular product thumbnails as size selectors.                                                                                                                                               |
| Iconography        | **Not documented.** Preview shows simple line icons in circular icon buttons and 32px product-tab glyphs.                                                                                                                                                                   |
| Data-viz           | **Not documented** (no charts in the analysis). Nutrition table is the only tabular data.                                                                                                                                                                                   |
| Micro-interactions | `scale(0.95)` press on every button, `all 0.2s ease`; Frap ambient shadow fades on press; a `cubic-bezier(0.32,2.32,0.61,0.27)` overshoot on the checked radio marker.                                                                                                      |
| Empty states       | **Not documented.**                                                                                                                                                                                                                                                         |

**Maps to Legend.** QR menu grid and item sheet (PDP cluster: breadcrumb → size/variant selector
with circular thumbs → add-in rows with floating labels → stepper → paired actions
_Customize_ / _Add to Order_), member tier card, rewards band.

**Take:** the PDP component cluster; role-mapped accent tiers; ceremony color used once; the
paired secondary+primary action row; pill CTA with press scale.
**Refuse:** the proprietary typefaces, the gold-on-green brand pairing, the script face.

Evidence: `starbucks/01-hero-palette-1440.png`, `starbucks/02-type-scale-1440.png`, `starbucks/03-buttons-components-1440.png`, `starbucks/05-cards-1440.png`, `starbucks/06-pdp-customize-1440.png`, `starbucks/07-layout-depth-1440.png`, `starbucks/04-hero-390.png`.

---

### 3.2 Airbnb — customer menu, favorites, hospitality

**Why it reads premium.** It trusts photography instead of typographic muscle: the homepage h1 is
only 28px/700 because the imagery carries the weight. One accent (Rausch) appears on maybe two
elements per screen; everything else is white + ink.

**Signature move.** The photo-first property card: 1:1 photo plate with 14px corner clipping, a
floating "Guest favorite" badge top-left, heart top-right, then four lines of meta (title +
rating, category, dates, price). The rating is the one loud typographic moment in the whole
system — 64px/700.

| Attribute          | What the reference does                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 4px base with a 2px micro-step: 2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Sections at 64 (tighter than SaaS 80–96 because marketplace density). Card meta padding 16; card grids 16 apart. |
| Type               | Cereal VF. Display 20–28px at 500–700, body 16/400, meta 14/400, badge 11/600. Almost no tracking except `-0.44px` at 22px and `-1px` on the 64px rating.                                 |
| Surfaces           | One shadow tier total, used on hover/dropdowns only. Depth comes from white-on-white separation, rounded clipping, and photography.                                                       |
| Accent             | Rausch for primary CTA, search orb, heart save state, inline links. Disabled = pale tint (`#ffd1da`). Error red is a separate, darker red.                                                |
| Imagery            | Photo-first: 1:1 property plates, 4:5 experience cards, full-bleed listing banner. Floating badges and hearts sit on the image.                                                           |
| Iconography        | Hand-illustrated 32px product-tab glyphs with NEW badges; circular icon buttons (back arrow, toolbar) on `surface-strong`.                                                                |
| Data-viz           | **Not documented.** The 64px rating display is the only numeric moment.                                                                                                                   |
| Micro-interactions | Press = background darkens to `primary-active`, no transform. Hover = the single shadow tier.                                                                                             |
| Empty states       | **Not documented.**                                                                                                                                                                       |

**Maps to Legend.** QR menu grid (1:1 or 4:5 plates, badge for "Best seller"/"Baru", heart for
favorites), member favorites, reservation listing, outlet/experience cards on the website.

**Take:** photo plate + floating badge + 4-line meta; the "one loud number" rule; the
single-accent budget; the 64px section rhythm.
**Refuse:** Rausch coral, Cereal, the travel-specific badge language.

Evidence: `airbnb/06-property-cards-1440.png`, `airbnb/07-rating-display-1440.png`, `airbnb/05-cards-1440.png`, `airbnb/01-hero-1440.png`, `airbnb/02-components-1440.png`, `airbnb/04-layout-depth-1440.png`, `airbnb/03-hero-390.png`.

---

### 3.3 Uber — POS, KDS, expo, table board

**Why it reads premium.** A black-and-white duet with zero accent palette, where the only
decoration is editorial illustration and the only shape is the pill. Contrast does the work that
color does elsewhere.

**Signature move.** Alternating polarity bands: white feature card → black promo card with white
text and white CTA → white → black footer. The polarity flip _is_ the depth cue.

| Attribute          | What the reference does                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spacing            | 4px base: 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32. Marketing bands 32; cards pad 24; form cards pad 16; inline gaps 12.                                                                         |
| Type               | UberMove 700 for display 20–52px with 1.22–1.25 line-height, never letter-spaced; UberMoveText 400/500 for body/buttons at 12–18px. Sentence case everywhere; uppercase only for eyebrows. |
| Surfaces           | Level 0 flat (most surfaces), L1 `0 4px 16px / 12%` for promo cards, L2 `16%` for the hero form card, L3 `0 2px 8px / 16%` for the floating pill.                                          |
| Accent             | None. Black is the only conversion color; gray `#efefef` pills for tertiary. No semantic palette on marketing.                                                                             |
| Imagery            | 4:3 editorial illustrations inside promo cards; 4:5 portraits; 2:3 showcase at desktop. Monochrome logo strip.                                                                             |
| Iconography        | **Not documented.** Preview shows circular icon containers (`rounded.full`) and category chips.                                                                                            |
| Data-viz           | **Not documented.**                                                                                                                                                                        |
| Micro-interactions | Pressed white pills go `#e2e2e2`; translucent tab pill hovers to `#282828`. No transforms documented.                                                                                      |
| Empty states       | **Not documented.**                                                                                                                                                                        |

**Maps to Legend.** POS tile grid, KDS ticket, expo runner list, table status board, pickup
screen. The "kontras" density already references this system.

**Take:** pill-only interactive shape; polarity bands for emphasis (dark ticket for late/urgent,
not a colored border); 16px cards with 4px-based padding; sentence-case + 700 display.
**Refuse:** pure black as the only CTA (Legend needs a tenant accent), UberMove.

Evidence: `uber/01-hero-1440.png`, `uber/02-components-1440.png`, `uber/04-layout-depth-1440.png`, `uber/05-cards-1440.png`, `uber/06-signature-1440.png`, `uber/07-signature-390.png`, `uber/03-hero-390.png`.

---

### 3.4 Linear — management (kelola), owner

**Why it reads premium.** The deepest dark canvas in the collection plus a four-step surface
ladder, hairlines, and aggressive negative tracking. Depth without a single drop shadow.

**Signature move.** Surface ladder + hairline borders: canvas → surface-1 → surface-2 →
surface-3 → surface-4, each lift a slightly lighter fill with a 1px border. Cards are 12px, not
pill.

| Attribute          | What the reference does                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 96. Cards pad 24, testimonials 32, CTA banners 48. Sections 96.                                                                                              |
| Type               | Display 80/600 with **-3.0px** tracking (≈4% of size), scaling to -0.4px at 22px and -0.05px at 16. One family display→body; eyebrow uses **positive** +0.4px to mark taxonomy. Mono only for IDs/code. |
| Surfaces           | Four-step ladder, 1px hairline (`#23252a` → stronger), a faint top-edge white highlight on lifted panels. No drop shadows on dark.                                                                      |
| Accent             | One lavender-blue on brand mark, focus ring, primary CTA. One semantic green. Nothing else.                                                                                                             |
| Imagery            | Product UI screenshots as the protagonist; no atmospheric gradients, no spotlight cards.                                                                                                                |
| Iconography        | **Not documented.** Preview shows 16–20px monochrome line icons inside 8px-radius buttons.                                                                                                              |
| Data-viz           | Product screenshots contain dense issue lists and dashboards; no standalone chart system documented.                                                                                                    |
| Micro-interactions | Hover/press variants per button (`primary-hover`, `primary-pressed`); focus ring 2px at 50%.                                                                                                            |
| Empty states       | **Not documented.**                                                                                                                                                                                     |

**Maps to Legend.** Management shell, kelola list/detail, owner dashboards, platform admin. The
"padat" density already points here.

**Take:** the surface ladder idea (translated to warm neutrals); hairline + tonal lift instead of
shadow; display tracking; mono for codes/IDs; 12px cards; dense row heights.
**Refuse:** the near-black canvas as Legend's default (Legend is white-first), lavender accent.

Evidence: `linear/01-hero-1440.png`, `linear/02-components-1440.png`, `linear/04-layout-depth-1440.png`, `linear/05-cards-1440.png`, `linear/03-hero-390.png`.

---

### 3.5 Mercury — owner, finance, shareholder

**Why it reads premium.** It is quiet on purpose: light variable weights (360 body / 420 UI /
480 headline), no bold anywhere, one saturated indigo pill, and everything else in translucent
capsules. Depth is tonal — cards lift one step of color, not shadow.

**Signature move.** Two native worlds: a dark "night" homepage (`#171721`, cards at `#1e1e2a`)
and light product pages (`#fbfcfd` canvas, `#edecfb` lavender cards), both bracketed by the
night nav and footer.

| Attribute          | What the reference does                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 8px base: 8 / 12 / 16 / 20 / 24 / 32 / 40 / 80 / 128. Cards pad 32; pills 20 horizontal; sections 80–128.                                                           |
| Type               | arcadiaDisplay 480 for 24–60px with **positive** +0.42px tracking at card sizes; arcadia 360 body, 420 UI, 500 eyebrows. Hierarchy from size and color, not weight. |
| Surfaces           | Level 0 flat, separated by fill; Level 1 a very faint layered shadow (2–9% ink) under pricing card/mockups; Level 2 glow from imagery on night.                     |
| Accent             | Indigo `#5266eb` only on the primary pill, pricing toggle, plan-name accent, and a 10% tint behind secondary pills.                                                 |
| Imagery            | Luminous 3D illustrations on the dark homepage; product screenshots in 12–16px frames.                                                                              |
| Iconography        | **Not documented.** Preview shows small chevrons in nav pills and icon-led feature lists.                                                                           |
| Data-viz           | Stat blocks: 60px/480 numerals with a small caption, four across. No chart grammar documented.                                                                      |
| Micro-interactions | `toggle-switch` in indigo; hover states on translucent pills. No transforms documented.                                                                             |
| Empty states       | **Not documented.**                                                                                                                                                 |

**Maps to Legend.** Owner dashboard, finance/reports, shareholder statement, tenant settings.

**Take:** light-weight hierarchy (size + color, not weight); tonal card lift; 40px capsule
secondary buttons; 32px card padding; stat block numerals.
**Refuse:** the dark-homepage-first posture, indigo, 3D glow art.

Evidence: `mercury/01-hero-1440.png`, `mercury/02-components-1440.png`, `mercury/04-layout-depth-1440.png`, `mercury/05-cards-1440.png`, `mercury/03-hero-390.png`.

---

### 3.6 Stripe — payments, finance, reports

**Why it reads premium.** Editorial thin display type (Sohne 300, -1.4px at 56px), a single
indigo filled pill per band, and — the detail that matters for Legend — **tabular figures on
every money cell**.

**Signature move.** Tabular-figure money type: `font-feature-settings: "tnum"` plus -0.42px
tracking on 14px numeric tables. The brand signals its financial DNA through a micro-detail.

| Attribute          | What the reference does                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 8px base with 2/4/12 sub-tokens: 2 / 4 / 8 / 12 / 16 / 24 / 32 / 64. Marketing 64–96; dashboard 32–48; feature cards pad 32, mockups 24.          |
| Type               | Sohne 300 for display 26–56px with -0.26 to -1.4px tracking; body 15–16/300; buttons 14–16/400; `tnum` on numeric cells; `ss01` globally.         |
| Surfaces           | Flat default; L1 `rgba(0,55,112,0.08) 0 1px 3px` card lift; L2 `0 8px 24px + 0 2px 6px` floating panels; L3 the gradient mesh (decorative depth). |
| Accent             | One indigo filled pill per band; ruby/magenta only inside the gradient and chart dots, never buttons.                                             |
| Imagery            | Product UI mockups (dashboard composites) more than photography; 12px chrome, subtle shadow.                                                      |
| Iconography        | **Not documented.** Preview shows small monochrome line icons in nav and cards.                                                                   |
| Data-viz           | Composited dashboard with chart cards; money cells use `tnum`; charts sit inside rounded chrome.                                                  |
| Micro-interactions | Press color `primary-press`; hover variants documented per button.                                                                                |
| Empty states       | **Not documented.**                                                                                                                               |

**Maps to Legend.** Payments admin, refunds/reconciliation, finance tables, report cards, money
in POS/checkout.

**Take:** `tnum` everywhere money appears; thin display for report titles; tonal card + faint
shadow for floating panels; dashboard chrome with 12px frames; one filled pill per band.
**Refuse:** the gradient mesh (DESIGN.md explicitly forbids gradient washes), indigo, Sohne.

Evidence: `stripe/01-hero-1440.png`, `stripe/02-components-1440.png`, `stripe/04-layout-depth-1440.png`, `stripe/05-cards-1440.png`, `stripe/03-hero-390.png`.

---

### 3.7 Sentry — management, platform admin

**Why it reads premium.** Two honest polarities — deep violet midnight for marketing, white for
pricing/dense reference — with the same chrome, flipped. Plus a "featured tier is the dark one"
rhythm instead of the usual accent border.

**Signature move.** Inverted featured card: the paid tier is the dark surface on a white page,
not a colored outline. One dominant CTA per page, polarity-flipped per canvas.

| Attribute          | What the reference does                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 8px base: 2 / 4 / 8 / 12 / 16 / 24 / 32 / 96. Cards pad 32; compact groups 16; form fields 8×12. Sections 96 desktop, 32–48 mobile.                                                                                       |
| Type               | Custom chunky display 60–88/500–700; Rubik for all UI (16/500 body, 14/700 button caps, 10/600 micro-caps). Uppercase buttons/eyebrows with +0.2px. Two leading worlds: marketing 2.0, product 1.5.                       |
| Surfaces           | Dark canvas `#1f1633` with `#150f23` cards and `#362d59` hairlines; light canvas white with `#e5e7eb` hairlines. L1 8% shadow for inverted buttons, L2 10% for floating cards, L3 a canvas-colored glow halo, L4 pressed. |
| Accent             | Lime as a **typographic highlight** wrapping single headline words, pink for sticker outlines/chart points, violet for tags/links. Lime is never a button.                                                                |
| Imagery            | Sticker mascots at section junctions (never inside cards, never buttons); starfield texture; hand-drawn squiggle divider.                                                                                                 |
| Iconography        | **Not documented.** Preview shows 16–20px line icons in nav and violet token pills.                                                                                                                                       |
| Data-viz           | Chart points in pink; dense pricing comparison tables on white. No full chart grammar documented.                                                                                                                         |
| Micro-interactions | Pressed inverted buttons darken (`#efefef`); hover on ghost fills.                                                                                                                                                        |
| Empty states       | **Not documented.**                                                                                                                                                                                                       |

**Maps to Legend.** Platform admin, kelola dense tables, pricing/plan screens, audit log.

**Take:** dark-inverted featured card for the selected/primary plan or the "urgent" KDS ticket;
polarity-flipped CTA (white on dark, dark on light); uppercase micro-caps for table headers;
dense table rhythm on white.
**Refuse:** lime/pink sticker language, mascots (DESIGN.md forbids decorative illustration),
starfield.

Evidence: `sentry/01-hero-1440.png`, `sentry/02-components-1440.png`, `sentry/04-layout-depth-1440.png`, `sentry/05-cards-1440.png`, `sentry/03-hero-390.png`.

---

## 4. Five additional references for a café super app

Chosen because the catalog's featured set has no other F&B brand: these cover the four surfaces
the PRD references do not (warm consumer, friendly money, commerce admin, booking).

### 4.1 Oura — member, shower/WFC, rewards

**Why it fits.** The only reference whose canvas is _warm paper_ (`#f7f1e8`), not white, and
whose palette is earth tones used for data-viz and illustration while a single action blue is
reserved for CTAs. That is exactly the color discipline a café brand needs: warm atmosphere,
cold action.

| Attribute          | What the reference does                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | Generous editorial rhythm; sections separated by long vertical silences; 4-up → 2-up → 1-column responsive.                                                         |
| Type               | Editorial New serif 300 at 40–110px for headlines; AkkuratLL grotesque 400 at 18/1.5 body, 16/600 buttons, 12/700 eyebrows. Serif = ceremony, sans = reading.       |
| Surfaces           | Three worlds: cream editorial → near-black news/footer band with cream cards floating → silver product stage. Hairline rules, flat fills.                           |
| Accent             | Action blue only on decisive CTAs ("Explore", "Shop"); warm stone for quieter buttons, fields, outlines, links; mustard/clay/olive for bands, illustration, scores. |
| Imagery            | Full-bleed lifestyle photography leads; UI recedes to hairlines and quiet labels.                                                                                   |
| Iconography        | **Not documented.** Preview shows thin line icons and small-caps overlines.                                                                                         |
| Data-viz           | Earth-tone score/data visualization (rings, bars) as brand-native, not chart-library default.                                                                       |
| Micro-interactions | **Not documented.**                                                                                                                                                 |
| Empty states       | **Not documented.**                                                                                                                                                 |

**Maps to Legend.** Member PWA home, points/tier card, shower/WFC access ticket, rewards
ceremony, website.

**Take:** warm tint band + serif display for ceremony moments (tier upgrade, reward unlocked);
action color only on the decisive CTA; earth-tone chart palette; overline eyebrows.
**Refuse:** the cream canvas as Legend's default (white-first is a PRD requirement), the
proprietary serif.

Evidence: `oura/01-hero-1440.png`, `oura/02-components-1440.png`, `oura/03-layout-depth-1440.png`, `oura/04-hero-390.png`, `oura/05-cards-1440.png`.

---

### 4.2 Wise — checkout, split bill, wallet

**Why it fits.** The friendliest money UI in the set: 24px card radius, a currency-converter card
as the hero component, and a complete semantic palette (positive/warning/negative families).

| Attribute          | What the reference does                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Spacing            | 4px rhythm, sections at generous scale; converter card is the hero, full-width on mobile.            |
| Type               | Wise Sans 900 at 32–126px for brand moments; Inter 600 for sub-display; 16/400 body; 16/600 buttons. |
| Surfaces           | Sage-tinted hero band (`#e8ebe6`) with white cards inside; 24px radius everywhere.                   |
| Accent             | One lime CTA (`#9fe870`); full semantic palette for in-product states.                               |
| Imagery            | Product-first: the converter card is the visual.                                                     |
| Iconography        | **Not documented.**                                                                                  |
| Data-viz           | **Not documented** beyond the converter.                                                             |
| Micro-interactions | **Not documented.**                                                                                  |
| Empty states       | **Not documented.**                                                                                  |

**Maps to Legend.** Checkout, split bill, payment link, wallet/top-up, refund status.

**Take:** the converter-card composition (from/to rows + big amount + one CTA) for split-bill and
payment; 24px card radius on customer money surfaces; semantic families with content/hover/active.
**Refuse:** lime, 900-weight display, the sage band.

Evidence: `wise/01-hero-1440.png`, `wise/02-components-1440.png`, `wise/03-layout-depth-1440.png`, `wise/04-hero-390.png`.

---

### 4.3 Shopify — kelola catalog, merchant-style admin

**Why it fits.** Two parallel tracks sharing one button vocabulary: cinematic marketing and calm
transactional admin. Legend's kelola needs the transactional track — comparison tables, pricing
tiers, signup flows on a barely-warm off-white.

| Attribute          | What the reference does                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Spacing            | Light track is dense and calm; tables and tiers sit on `canvas-light` / `canvas-cream`.          |
| Type               | Neue Haas Grotesk Display 330 (thin) at 48–96px; Inter Variable 420–550 for UI; `ss03` globally. |
| Surfaces           | Two canvases, never blended: black cinematic vs off-white transactional.                         |
| Accent             | Aloe/pistachio mints only on the light track, for commerce/success signals.                      |
| Imagery            | Full-bleed merchant photography on the dark track; no inset cards.                               |
| Iconography        | **Not documented.**                                                                              |
| Data-viz           | **Not documented.**                                                                              |
| Micro-interactions | **Not documented.**                                                                              |
| Empty states       | **Not documented.**                                                                              |

**Maps to Legend.** Kelola catalog, menu back office, plan/billing screens, merchant-style
onboarding.

**Take:** the "never blend the two tracks" rule (marketing vs transactional surfaces get
different rhythm); thin display for admin page titles; 550-weight body emphasis.
**Refuse:** pure black cinematic canvas, thin 330 weights for UI (below Legend's legibility bar).

Evidence: `shopify/01-hero-1440.png`, `shopify/02-components-1440.png`, `shopify/03-layout-depth-1440.png`, `shopify/04-hero-390.png`.

---

### 4.4 Notion — management, CMS, policy pages

**Why it fits.** Warm paper-soft off-white, one structural blue, and a multi-color palette that
is _decorative only_. It proves you can add personality without breaking a monochrome UI.

| Attribute          | What the reference does                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Spacing            | 8px base; cards pad 24; sections ~96; 3-up grids collapsing to 1.                                                           |
| Type               | NotionInter 700 at 22–64px with tight tracking (−2.125px at 64px); 16/400 body; 15/400 dense table rows; 16/500 buttons.    |
| Surfaces           | Hairlines + barely-there layered shadow; 12px cards, 8px utility buttons, pill marketing CTAs; one dark indigo hero island. |
| Accent             | One blue for CTAs/links; six sticker colors that never paint structure.                                                     |
| Imagery            | Small illustrated blocks, app-icon stickers, category dots.                                                                 |
| Iconography        | **Not documented** beyond the sticker system.                                                                               |
| Data-viz           | **Not documented.**                                                                                                         |
| Micro-interactions | **Not documented.**                                                                                                         |
| Empty states       | **Not documented.**                                                                                                         |

**Maps to Legend.** Management shell, CMS/policy pages, help center, onboarding.

**Take:** warm off-white as an _optional_ band (not the page), one structural accent, decorative
color confined to badges/illustration, 12px cards with hairline + faint shadow.
**Refuse:** sticker palette inside operational screens, the dark indigo island.

Evidence: `notion/01-hero-1440.png`, `notion/02-components-1440.png`, `notion/03-layout-depth-1440.png`, `notion/04-hero-390.png`.

---

### 4.5 Cal.com — reservation, waitlist, pickup slots

**Why it fits.** Booking clarity: a monochrome CTA, light-gray cards, and real product UI
fragments (calendar widgets, slot pickers) shown at small scale inside marketing cards.

| Attribute          | What the reference does                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Spacing            | 96px section rhythm; card padding 24; 3-up pricing.                                                           |
| Type               | Cal Sans 600 at 28–64px with −0.5 to −2px tracking; Inter 400/500/600 for body, nav, buttons; 14/600 buttons. |
| Surfaces           | White canvas + `#f5f5f5` cards; featured pricing tier flips to `#101010`; dark footer closes every page.      |
| Accent             | Black primary CTA only; no second accent.                                                                     |
| Imagery            | Real product chrome embedded in cards (calendar, schedule picker, integration grid).                          |
| Iconography        | Circular 36px avatars; **icon set not documented.**                                                           |
| Data-viz           | **Not documented.**                                                                                           |
| Micro-interactions | `nav-pill-group` wrapper; hover states not documented.                                                        |
| Empty states       | **Not documented.**                                                                                           |

**Maps to Legend.** Reservation/waitlist, pickup time slots, table booking, staff scheduling.

**Take:** slot-picker composition (day strip + time grid + one CTA), monochrome CTA with a single
accent only where it carries meaning, dark closing band.
**Refuse:** embedding fake product mockups (DESIGN.md forbids fake app mockups) — use real
components instead.

Evidence: `cal/01-hero-1440.png`, `cal/02-components-1440.png`, `cal/03-layout-depth-1440.png`, `cal/04-hero-390.png`.

---

## 5. What repeats across all twelve

These are the patterns that survive translation, and the reason the moves in §7 are ordered the
way they are.

1. **A neutral palette is made premium by its surface ladder, not its accent.** Linear (4 steps),
   Mercury (2 worlds), Sentry (2 polarities), Notion (hairline + faint shadow). Legend currently
   has one card surface and one border.
2. **One accent, used scarcely.** Every reference spends its color on ≤2 elements per screen.
   Legend's Base Theme has zero; the tenant theme has an accent but screens rarely use it.
3. **Photography beats typography for consumer surfaces.** Airbnb, Starbucks, Oura, Shopify all
   let imagery carry the hierarchy and keep display type modest. Legend's menu shows letter
   tiles.
4. **Display type is either very tight or very light — never both heavy and large.** Linear
   -4% tracking, Notion -2.1px, Stripe 300 weight, Mercury 480 weight. Legend's display is
   30–36px/700 with default tracking: the least distinctive combination.
5. **The pill is a system decision, not a decoration.** Uber pills everything; Starbucks pills
   buttons only; Linear refuses pills except toggles. Legend already has `rounded-control` per
   density — it just needs to be applied consistently and paired with non-pill media.
6. **Depth is polarity or tone before it is shadow.** Dark band, tinted card, hairline lift.
   Shadows appear only for floating/overlay states.
7. **Money gets its own typography.** Stripe `tnum`, Mercury 60px stat numerals, Airbnb 64px
   rating. Legend already has `<Money>` + `tabular`; it lacks size tiers and currency scaling.
8. **Empty states are a design surface, not an afterthought.** None of these analyses documents
   one — which is exactly why Legend's `DataTableShell`/`EmptyState` (already specified with
   loading/empty/no-results/error) is ahead of the references and should be extended, not
   replaced.

---

## 6. Translation rules (so this does not become brand copying)

| Reference device                  | Legend translation                                                                    | Never                               |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| Starbucks four-tier green         | Tenant Theme accent ramp: `primary`, `brand`, `brand-subtle` + one `accent-tint` step | Green hex, gold ceremony, SoDoSans  |
| Airbnb Rausch + photo cards       | Tenant accent + `MenuCard` media variant                                              | Coral hex, Cereal, "Guest favorite" |
| Uber black pills + polarity bands | `rounded-control` pill + ink band for urgent tickets                                  | Pure-black CTA as the only action   |
| Linear dark ladder                | Warm-neutral surface ladder in both modes                                             | `#010102` canvas, lavender          |
| Mercury light weights             | Weight 500–600 display instead of 700; tonal cards                                    | arcadia, indigo                     |
| Stripe `tnum` + gradient          | `tnum` money tiers only                                                               | Gradient mesh, indigo               |
| Sentry inverted featured card     | Dark card for the selected plan / late ticket                                         | Lime, mascots                       |
| Oura warm paper + serif           | Optional warm tint band + serif for ceremony only                                     | Cream page default, Editorial New   |
| Wise converter card               | Split-bill/payment composition                                                        | Lime, 900 display                   |
| Shopify two tracks                | Marketing vs transactional rhythm split                                               | Pure black cinematic canvas         |
| Notion stickers                   | Decorative color only in badges/illustration                                          | Stickers in ops screens             |
| Cal.com slot picker               | Reservation/pickup composition                                                        | Fake product mockups                |

---

## 7. Ranked upgrade moves for `DESIGN.md`

Ordered by visual impact. Each row names the token/component/shell change, the surface it
targets, the reference it comes from, and the guardrail that keeps it inside Legend's rules.
**None of these is implemented yet.** Rank numbers are global; the waves group the work by
implementation order (tokens → components → shells), and each wave is listed in rank order.

### Wave A — tokens only (no component rewrite)

**1. Apply the tenant accent for real.** ★★★★★
Today `--primary` is near-black in the Base Theme, so every CTA is monochrome; the tenant accent
exists (`cafe-legend.ts` → `#8a4423`) but screens rarely surface it. Keep `primary` as the action
color and add the missing steps around it — `--primary-hover`, `--primary-tint` (10–12% wash),
`--primary-tint-strong`, and reuse `brand-subtle` — then document an accent budget: **one filled
accent surface and at most two accent details per viewport** (CTA, active nav, one badge). Keep
the Base Theme neutral; the accent comes from the Tenant Theme. _Source:_ Starbucks role-mapped
greens, Airbnb single-accent budget, Oura action-only blue. _Guardrail:_ the contrast gate
already enforces AA on `primary`/`brand`; add the new tint pairs to `REQUIRED_PAIRS`.

**3. Three-step surface ladder + one interactive elevation.** ★★★★☆
Add `--surface-1` (page), `--surface-2` (card), `--surface-3` (raised: selected segment, hovered
card, sticky summary), each a small tonal step in both modes, plus `--elevation-card` used only
for hover/selected/dragging. Cards stop relying on the 1px border alone; the border stays as the
resting edge. _Source:_ Linear's 4-step ladder, Mercury's tonal lift, Notion's hairline+shadow.
_Guardrail:_ DESIGN.md's "no shadow on resting surfaces" stays true — the shadow is only for
interactive lift.

**4. Expand the type scale and add display tracking.** ★★★★☆
Current: display 30/36 bold, title 24, heading 20/18, body 16/18, small 14, micro 12. Add
`display-xl` 44/48, `display-2xl` 56/60 (customer hero and management page titles only), and
`money-display` 32/36 tabular. Set display tracking to `-0.02em` and reduce display weight from
700 to 600 so size carries the hierarchy. _Source:_ Airbnb's modest display + 64px rating, Notion
-2.125px at 64px, Stripe thin display, Mercury 480. _Guardrail:_ keep 16px minimum body; no
`text-<customname>` classes (existing gotcha).

**9. Radius/pill intent per density.** ★★★☆☆
Add four semantic aliases over the existing scale (which stays untouched): `rounded-media` (12),
`rounded-container` (16, today's `rounded-xl`), `rounded-control` (pill in Hangat, 8 Kontras,
6 Padat — already exists), `rounded-sheet` (24, today's `rounded-t-2xl`). Media is never pill;
controls are never square in Hangat. _Source:_ Uber pill-only, Starbucks 12px cards + 50px pills,
Wise 24px cards. _Guardrail:_ every radius stays a multiple of `--radius-unit`.

**12. Dark mode: true dark ladder + alpha hairlines.** ★★★☆☆
Replace the single dark card tone with `#0f0e0d` page / `#171614` surface-2 / `#1f1d1b`
surface-3, and switch borders to `rgba(255,255,255,0.08)` / `0.14` so edges read on dark.
_Source:_ Linear 4-step dark, Mercury night/night-raised. _Guardrail:_ re-run the 74-pair
contrast gate.

**13. Imagery rules: aspect locks, scrim, warm placeholder.** ★★★☆☆
Add `--ratio-card` (1:1), `--ratio-hero` (3:2), `--ratio-thumb` (4:5), a `--scrim-media` token for
text-on-image, and a rule that a missing image renders a warm tonal plate with the category icon —
never a letter tile. _Source:_ Airbnb photo plates, Oura full-bleed, Shopify full-bleed.
_Guardrail:_ storage pipeline already strips EXIF and emits WebP; no new asset pipeline.

### Wave B — components

**2. Photo-first menu/member cards.** ★★★★★
New `MenuCard` variant: media plate (1:1) with `rounded-media`, floating badge top-left
(`Best seller`/`Baru`/`Habis`), favorite heart top-right, then title, one-line description,
price + add button. Skeleton mirrors the media shape. This single change removes the biggest
"plain" signal in the customer app (letter tiles). _Source:_ Airbnb property cards, Starbucks
PDP, Oura photography. _Guardrail:_ fixtures must ship real sample photos; label as "Contoh
data" per DESIGN.md.

**6. Ops board status hierarchy.** ★★★★☆
Occupied tables get a tinted surface (`--surface-3` + status tint), urgent states (late timer,
waiter call) get a solid pill and a 3px left accent rule; calm states stay tinted. Table code
goes to 28/32 semibold, zone strip becomes a segmented control with counts. _Source:_ Uber
polarity bands, Sentry inverted featured card, Linear tonal lift. _Guardrail:_ status stays
icon + text; color never alone.

**7. Money/number display system.** ★★★☆☆
`MoneyDisplay` with three sizes (`inline` 16, `stat` 28, `hero` 40), currency at 0.7em and
`text-muted-foreground`, `tnum` + `tabular` always, right-aligned in tables, negative in danger
with a true minus. _Source:_ Stripe `tnum`, Mercury 60px stat blocks, Airbnb's one loud number.
_Guardrail:_ `<Money>`/`formatRupiah` remains the only formatter.

**10. Empty/loading states with functional glyphs.** ★★★☆☆
`EmptyState` gets a 48–64px functional glyph in `accent-tint` (not a decorative illustration),
a one-sentence hint, and one next action; `Skeleton` gets media/row/table shapes. _Source:_ the
references do not document empty states — this is Legend extending its own `DataTableShell`
pattern. _Guardrail:_ DESIGN.md forbids decorative illustration; the glyph must explain the state.

**14. Data-viz style for management.** ★★☆☆☆
Chart wrapper tokens: 2px line weight, horizontal gridlines only at 0.5 opacity, baseline 1px,
one accent series + two neutral series, 12px chart card, tabular axis labels, empty chart shows
the hint instead of an empty grid. _Source:_ Stripe dashboard chrome, Mercury stat blocks, Sentry
dense tables. _Guardrail:_ PRD's "no decorative deltas or sparklines" on StatTile stays.

**15. Iconography pass.** ★★☆☆☆
1.5px stroke at 20px (24px in Kontras), 2px corner radius on joins, filled variant for active nav
items, optical alignment in 24px boxes. _Source:_ observed in all previews; not documented by the
analyses. _Guardrail:_ emoji icons remain forbidden.

### Wave C — shells and page composition

**5. Customer page band rhythm.** ★★★★☆
`CustomerShell` gains an optional band sequence: white hero → `surface-2` content band → ink
band for the rewards/ceremony moment → white. Bands are full-bleed, content stays `max-w-2xl`.
_Source:_ Starbucks cream/white/deep-green rhythm, Oura cream/ink/silver, Sentry polarity flip.
_Guardrail:_ page stays white by default; the tint band is a Tenant Theme option, and the ink band
appears at most once per page.

**8. Management shell navigation.** ★★★☆☆
Sidebar 240 → 256px, nav grouped under uppercase eyebrow labels, selected row = `accent-tint`
fill + 2px accent left rule + semibold label; below 64rem collapse to a 64px icon rail (labels in
tooltips) before the Sheet fallback; topbar 56px with breadcrumb + global search + one primary
action. _Source:_ Mercury nav pills, Linear sub-nav, Notion calm chrome. _Guardrail:_ container
queries (already used), no new breakpoints.

**11. Micro-interaction pass.** ★★★☆☆
`active:scale-[0.97]` on buttons and tappable cards at `--duration-fast`; sheets enter with
`ease-enter` 320ms and a 12px translate; totals count up over 240ms on change (money only);
cart badge pops once on add; toasts slide 8px + fade. _Source:_ Starbucks `scale(0.95)`,
Airbnb press color, Linear fast hovers. _Guardrail:_ everything collapses to 0 under
`prefers-reduced-motion` (already wired); no looping or scroll-triggered motion.

---

## 8. What must not change

These are PRD/DESIGN.md commitments the upgrade must respect — several reference devices are
explicitly out of bounds:

- **White page in light mode.** Cream/ink bands are accents, never the default canvas.
- **No gradient washes, glassmorphism, glow, bento grids, fake app mockups, decorative
  illustrations, emoji icons.** That rules out Stripe's mesh, Sentry's mascots, Cal.com's fake
  product composites, and Mercury's 3D glow art as literal devices.
- **One primary CTA per view**, status always icon + text, no color-only meaning.
- **Three densities** and their control heights stay; the upgrade changes surfaces and type, not
  the density contract.
- **AA contrast gate** (74 pairs) must pass in both modes for Base, Kontras, and every Tenant
  Theme; new tokens add new pairs.
- **No raw colors outside `tokens.css`**, no tenant branching in code.
- **16px minimum body text**; `tabular` for every number.

---

## 9. Evidence index

| Folder       | Files                | Contents                                                                           |
| ------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `starbucks/` | 7 PNG + `excerpt.md` | hero/palette, type scale, buttons, cards, PDP customizer, layout/depth, mobile     |
| `airbnb/`    | 7 PNG + `excerpt.md` | hero, buttons, top nav/cards, layout/depth, property cards, rating display, mobile |
| `uber/`      | 7 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, signature, mobile signature, mobile hero       |
| `linear/`    | 5 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, mobile                                         |
| `mercury/`   | 5 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, mobile                                         |
| `stripe/`    | 5 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, mobile                                         |
| `sentry/`    | 5 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, mobile                                         |
| `oura/`      | 5 PNG + `excerpt.md` | hero, buttons, cards, layout/depth, mobile                                         |
| `wise/`      | 4 PNG + `excerpt.md` | hero, buttons, layout/depth, mobile                                                |
| `shopify/`   | 4 PNG + `excerpt.md` | hero, buttons, layout/depth, mobile                                                |
| `notion/`    | 4 PNG + `excerpt.md` | hero, buttons, layout/depth, mobile                                                |
| `cal/`       | 4 PNG + `excerpt.md` | hero, buttons, layout/depth, mobile                                                |

62 screenshots, ~5.8 MB total (limit 25 MB). Desktop captures are 1440×900; mobile captures are
390×844. All screenshots are of the getdesign.md live preview catalog, not of the brands' own
sites.

### Reproduce

```bash
npx getdesign@latest add <brand>        # writes DESIGN.md in the current dir
open https://getdesign.md/<brand>/design-md   # Preview tab renders the visual catalog
```
