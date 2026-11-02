# starbucks — DESIGN.md excerpt (reference only)

- Source: <https://getdesign.md/starbucks/design-md> (fetched 2026-11-02 with `npx getdesign@latest add starbucks`)
- Author: getdesign.md / VoltAgent — independent analysis of publicly observable patterns.
  Not affiliated with or endorsed by the brand; all brand names and marks belong to their owners.
- License: reference use inside this repository. Do not republish as your own.
- Scope: this file keeps the sections Legend's DESIGN.md work needs (theme, color, type,
  layout, elevation, shapes, do's/don'ts). Component specs are reduced to their names;
  see the live preview for the full spec.

## 1. Visual Theme & Atmosphere

Starbucks' design system is a **warm, confident retail flagship** wearing the green of their storefront apron across every surface. The canvas alternates between a neutral-warm cream (`#f2f0eb`) and a ceramic off-white (`#edebe9`) — colors that reference actual store materials: the paper napkins, the café walls, the wood finishes — while the signature **Starbucks Green** (`#006241`) anchors the brand moment on hero bands, CTAs, and the Rewards experience. The greens come in four calibrated shades (Starbucks, Accent, House, Uplift) each mapped to a specific surface role, and gold (`#cba258`) appears only around Rewards-status ceremony — not as a general accent.

Typography carries most of the brand voice. The proprietary **SoDoSans** typeface (custom to Starbucks) sits across nearly every surface with a tight `-0.16px` letter-spacing — it reads confident and friendly rather than fashion-magazine severe. What's unusual: the Rewards page switches to a warm serif (`"Lander Tall", "Iowan Old Style", Georgia`) for specific headline moments, subtly echoing the nostalgic feel of a coffeehouse chalkboard. And the Careers pages use a handwritten script (`"Kalam", "Comic Sans MS", cursive`) for personal cup-name touches. Three typefaces, three contexts — the system is disciplined about when each appears.

The surfaces breathe through rounded geometry. Every button is a 50px full-pill. Cards take a 12px rounded-rectangle. The "Frap" floating CTA — a 56px circular order button in Green Accent (`#00754A`) — is the product's signature depth move: it floats bottom-right with a layered shadow stack (`0 0 6px rgba(0,0,0,0.24)` base + `0 8px 12px rgba(0,0,0,0.14)` ambient) and compresses via `scale(0.95)` on press. Elevations are otherwise restrained — card shadows stay at a whispered `0.14/0.24` alpha, global nav gets a quiet three-layer shadow stack. The whole system feels like clean café signage: legible, warm, and never shouting.

**Key Characteristics:**

- Four-tier green brand system (Starbucks / Accent / House / Uplift) each mapped to a distinct surface role — not a single "brand green"
- Gold reserved for Rewards-status moments only; never a general-purpose accent
- Warm-neutral canvas (`#f2f0eb` / `#edebe9`) instead of cold white — references café materials
- Custom proprietary typeface (SoDoSans) with tight `-0.16px` letter-spacing as the universal voice
- Context-specific type switches: serif (Lander Tall) for Rewards, script (Kalam) for Careers cup-names
- Full-pill buttons (`50px` radius) universal, `scale(0.95)` active press the signature micro-interaction
- Floating "Frap" circular CTA (`56px`, Green Accent fill, layered shadow stack) — the product's signature elevation element
- Gift-card surfaces designed as **photographed physical product** — every card is a distinct illustrated photograph rather than a generated graphic
- 12px card radius + whisper-soft shadows keep content cards flat-plus-hint-of-lift
- Rem-based spacing scale anchored at 1.6rem (~16px) = `--space-3`, stepping to 6.4rem (~64px)

**Color-block page rhythm:** Cream hero → White content sections → Dark-green (`#1E3932`) feature band with white text → Cream utility zone → Dark-green (`#1E3932`) footer with gold / white text — an espresso-dark bookend around the bright body.

## 2. Color Palette & Roles

**Source pages analyzed:** homepage, rewards, gift cards, product detail (Pink Energy Drink), product nutrition (Cold Brew).

### Primary

- **Starbucks Green** (`#006241`): The historic brand green. Used on h1 headings, primary section headers on the Rewards page, and as the main brand signal wherever a single dominant color is needed.
- **Green Accent** (`#00754A`): A slightly brighter, more luminous green. The primary filled-CTA color ("Explore our afternoon menu", "See the spring menu") and the fill of the floating Frap circular button.
- **House Green** (`#1E3932`): The deep near-black brand green. Footer surface, feature-band backgrounds, reward-status dark surfaces, and the headline "Free coffee is just the beginning" hero band on Rewards.
- **Green Uplift** (`#2b5148`): A secondary mid-dark green used sparingly on decorative accents and dark-gradient moments.
- **Green Light** (`#d4e9e2`): A pale mint wash used for form-valid-state tints and light green utility surfaces.

### Secondary & Accent

- **Gold** (`#cba258`): Reserved almost exclusively for Rewards-status ceremony — Gold-tier callouts, partnership badges (SkyMiles, Bonvoy), and premium-feeling accents. Never a general-purpose brand color.
- **Gold Light** (`#dfc49d`): Softer gold for background washes on gold-tier sections.
- **Gold Lightest** (`#faf6ee`): Cream-gold page-surface wash used under partnership sections on the Rewards page — ties the gold accent back into the warm neutral system.

### Surface & Background

- **White** (`#ffffff`): Primary card and modal surface. Also card fill on gift-card tiles.
- **Neutral Cool** (`#f9f9f9`): Subtle cool-gray surface used on dropdown menus ("Account" dropdown), form-card wraps, and quiet utility containers.
- **Neutral Warm** (`#f2f0eb`): The warm cream **primary page canvas** for Rewards utility zones and hero bands.
- **Ceramic** (`#edebe9`): A slightly warmer/darker cream for zone separators, soft page-section washes, and Rewards partnership band.
- **Black** (`#000000`): Deep ink reserved for the dark top-of-page CTA strip ("Join now") and high-contrast top-nav sign-in buttons.

### Neutrals & Text

- **Text Black** (`rgba(0, 0, 0, 0.87)`): Primary heading and body text color on light surfaces. Not pure black — an 87%-opacity black that reads warmer.
- **Text Black Soft** (`rgba(0, 0, 0, 0.58)`): Secondary/metadata text on light surfaces.
- **Text White** (`rgba(255, 255, 255, 1)`): Primary heading/body text on dark green surfaces.
- **Text White Soft** (`rgba(255, 255, 255, 0.70)`): Secondary text on dark-green surfaces — footer link descriptions, caption text.
- **Rewards Green** (`#33433d`): A dedicated muted slate-green used only on Rewards-page text blocks — a slightly "dustier" reading color than Text Black that signals "reward surface" without using full Starbucks Green.

### Semantic & Accent

- **Red** (`#c82014`): Error and destructive state (form invalid, destructive actions).
- **Yellow** (`#fbbc05`): Warning state, legacy brand touch.
- **Green Light** (`#d4e9e2` at 33% opacity = `hsl(160 32% 87% / 33%)`): Form valid-field tint background.
- **Red Tint** (`hsl(4 82% 43% / 5%)`): Invalid-field tint on forms.

### Black / White Alpha Ladders

Two parallel translucent scales for overlay and secondary-text use:

- `rgba(0,0,0,0.06)` through `rgba(0,0,0,0.90)` in 10% steps — for dark overlays on light surfaces
- `rgba(255,255,255,0.10)` through `rgba(255,255,255,0.90)` in 10% steps — for light overlays on dark surfaces

### Gradient System

No structural gradient tokens observed. Surface hierarchy is solid-color-block throughout — the system relies on its five-tier cream/green surface palette rather than gradients.

## 3. Typography Rules

### Font Family

- **Primary:** `SoDoSans, "Helvetica Neue", Helvetica, Arial, sans-serif` — Starbucks' proprietary corporate typeface, used across nearly every surface
- **Loading Fallback:** `"Helvetica Neue", Helvetica, Arial, sans-serif` — what users see before SoDoSans loads
- **Rewards Serif:** `"Lander Tall", "Iowan Old Style", Georgia, serif` — used on specific Rewards-page headline moments for a warm editorial feel
- **Careers Script:** `"Kalam", "Comic Sans MS", cursive` — used exclusively for Careers-page "cup name" decorative touches, referencing the hand-written names on Starbucks cups

No OpenType stylistic sets explicitly activated at `:root`.

### Hierarchy

| Role                | Size           | Weight  | Line Height     | Letter Spacing | Notes                                        |
| ------------------- | -------------- | ------- | --------------- | -------------- | -------------------------------------------- |
| Display (text-10)   | 5.0rem / 80px  | 400–600 | 1.2             | -0.16px        | Largest Rewards/hero display                 |
| Jumbo (text-9)      | 3.6rem / 58px  | 400–600 | 1.2             | -0.16px        | Secondary hero headings                      |
| Hero Large (text-8) | 2.8rem / 45px  | 400–600 | 1.2–1.5         | -0.16px        | Landing section headlines                    |
| H1                  | 24px           | 600     | 36px            | -0.16px        | Starbucks-Green primary heading              |
| H2                  | 24px           | 400     | 36px            | -0.16px        | Regular-weight section title in Text Black   |
| Body Large          | 19px           | 400–600 | 33.25px (~1.75) | -0.16px        | Hero intro copy, feature-band body           |
| Body (text-3)       | 1.6rem / 16px  | 400     | 1.5 (24px)      | -0.01em        | Default body copy                            |
| Small (text-2)      | 1.4rem / ~14px | 400–600 | 1.5             | -0.01em        | Button label, metadata, form labels          |
| Micro (text-1)      | 1.3rem / ~13px | 400     | 1.5             | -0.01em        | Active float-label state, caption micro-copy |
| Button Label        | 14–16px        | 400–600 | 1.2             | -0.01em        | All pill-button labels                       |

**Letter-spacing tokens:**

- `letterSpacingNormal`: `-0.01em` (default — tight, characteristic)
- `letterSpacingLoose`: `0.1em` (emphasized caps)
- `letterSpacingLooser`: `0.15em` (uppercase-style labels, extreme emphasis)

**Line-height tokens:**

- `lineHeightNormal`: `1.5` (body)
- `lineHeightCompact`: `1.2` (display/buttons)

### Principles

- **Tight negative tracking (`-0.01em`)** is applied almost universally — the entire product reads slightly compressed, which gives SoDoSans its confident presence without feeling squeezed.
- **Weight shifts carry hierarchy, not size shifts.** H1 and H2 share the same 24px/36px size; only weight (600 vs 400) and color (Starbucks-Green vs Text Black) separate them.
- **Size tokens use rem, anchored to `1rem = 10px`** on this site (via a `font-size: 62.5%` root trick). So `1.6rem` = 16px, `2.4rem` = 24px, etc. The scale is semantic (textSize-1 through textSize-10), not arbitrary pixel values.
- **Context-specific typeface swaps** — serif on Rewards, script on Careers — are deliberate and localized. Never mix them with the primary sans within the same surface.
- **Body text never goes pure black** — it sits at `rgba(0,0,0,0.87)` to match the warm-neutral canvas temperature.

### Note on Font Substitutes

SoDoSans is proprietary to Starbucks (licensed from House Industries, not publicly available). Reasonable open-source substitutes:

- **Inter** (Google Fonts) — similar humanist geometric proportions, wide weight range
- **Manrope** — slightly rounder, similar confident feel
- **Nunito Sans** — warmer, good for a "café" brand substitute

If substituting, verify the tight `-0.01em` / `-0.16px` tracking still reads well; some open-source fonts need `-0.005em` instead.

Lander Tall (the Rewards serif) is custom — open-source substitutes: **Iowan Old Style** (already in fallback), **Lora**, or **Source Serif Pro**. Kalam (Careers script) is available on Google Fonts directly.

## 4. Component Stylings (component index)

### Buttons

**1.
**2.
**3.
**4.
**5.
**6.
**7.
**8.
**9.

### Cards & Containers

**Content Card (default)**
**Gift Card Tile**
**Rewards Status Cards (Rewards page signature)**
**Partnership Card (Rewards)**
**Dropdown Menu (Account dropdown, top-nav)**
**Modal**

### Inputs & Forms

**Floating Label Input**
**Option Icon (checkbox/radio)**

### Navigation

**Global Nav (top bar)**
**Sub-nav (second bar, e.g., Rewards internal)**
**Mobile Nav**

### Image Treatment

### Feature Band (dark-green hero strip)

### Expander / Accordion

### Cookie Consent Module

### Product Detail Components (PDP signature cluster)

**Size Options Selector**
**Add-in / Milk Select (outlined rectangle)**
**Numeric Stepper**
**Customize Button**
**Add to Order Button (PDP)**
**Rewards Cost Pill — "200★ item"**
**Product Description Band**
**Ingredients / Nutrition Table**
**Store Availability Selector**
**PDP Breadcrumb**
**Back Chevron Link (PDP nutrition / detail sub-pages)**

## 5. Layout Principles

### Spacing System

Rem-based semantic scale (anchored `1rem = 10px`):

| Token       | Rem      | Pixels | Typical Use                               |
| ----------- | -------- | ------ | ----------------------------------------- |
| `--space-1` | `0.4rem` | 4px    | Tightest inline padding                   |
| `--space-2` | `0.8rem` | 8px    | Small gap, button vertical padding        |
| `--space-3` | `1.6rem` | 16px   | Default — card padding, outer gutter xs   |
| `--space-4` | `2.4rem` | 24px   | Section inner spacing, outer gutter md    |
| `--space-5` | `3.2rem` | 32px   | Major between-section spacing             |
| `--space-6` | `4rem`   | 40px   | Large gaps, outer gutter lg, header crate |
| `--space-7` | `4.8rem` | 48px   | Section-to-section spacing                |
| `--space-8` | `5.6rem` | 56px   | Very large breathing — Frap height        |
| `--space-9` | `6.4rem` | 64px   | Widest section padding                    |

**Gutter tokens:**

- `--outerGutter: 1.6rem` (16px, default / mobile)
- `--outerGutterMedium: 2.4rem` (24px, tablet)
- `--outerGutterLarge: 4.0rem` (40px, desktop)

**Universal rhythm constant:** `1.6rem` (16px) appears across every page as the default outer gutter, card padding baseline, and text size 3 body — the system's most frequent spacing unit.

### Grid & Container

- Column width scale: `--columnWidthSmall: 343px` / `Medium: 500px` / `Large: 720px` / `XLarge: 1440px`
- Gift-card grid uses a 3-5-up responsive grid of `~343px` tiles
- Rewards status section: 3-up dark-green panels at `lg+` breakpoints
- Hero: asymmetric split 40% (image) / 60% (content) via `--headerCrateProportion` / `--contentCrateProportion`

### Whitespace Philosophy

Whitespace carries the feeling of "plenty of space in the café." Section padding leans generous (40–64px). Content blocks are separated by whitespace rather than dividers. The cream canvas (`#f2f0eb`) is itself a visual breath between white cards and green feature bands.

### Border Radius Scale

| Value           | Use                                                                                 |
| --------------- | ----------------------------------------------------------------------------------- |
| `12px`          | Cards, modals, menu-item tiles (`--cardBorderRadius`)                               |
| `12px 12px 0 0` | Full-width feedback tab (top-rounded only)                                          |
| `50px`          | All buttons — full-pill radius (`--buttonBorderRadius`)                             |
| `50%`           | Circular icons, Frap floating button, avatar thumbnails                             |
| Specialty       | `3.3333%/5.298%` elliptical for Starbucks-Visa-Card mockups (`--svcRoundedCorners`) |

## 6. Depth & Elevation

| Level                | Treatment                                                                         | Use                                                   |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Card                 | `0 0 0.5px rgba(0,0,0,0.14), 0 1px 1px rgba(0,0,0,0.24)`                          | Default content cards — a whisper-soft dual-shadow    |
| Global Nav           | `0 1px 3px rgba(0,0,0,0.1), 0 2px 2px rgba(0,0,0,0.06), 0 0 2px rgba(0,0,0,0.07)` | Triple-layer soft lift on the fixed top bar           |
| Frap Base            | `0 0 6px rgba(0,0,0,0.24)`                                                        | Base halo around the floating circular CTA            |
| Frap Ambient         | `0 8px 12px rgba(0,0,0,0.14)`                                                     | Stacked directional ambient — floats the Frap forward |
| Gift Card            | Light drop shadow around illustrated photograph                                   | Physical-card feel for gift tiles                     |
| Starbucks Card (SVC) | `drop-shadow(0 4px 1px rgba(0,0,0,0.11)) drop-shadow(0 0 2px rgba(0,0,0,0.24))`   | Stacked SVG drop shadows for Starbucks Card visuals   |

**Shadow philosophy:** Whisper-soft, layered over solid — the system never reaches for a single heavy drop shadow. Instead, it stacks 2–3 low-alpha shadows with different offsets to simulate real-world ambient + direct lighting. The Frap button is the most elevated element on any page.

### Decorative Depth

- **No gradient system** — surfaces are solid color-block
- **Color-block banding** carries perceived depth (dark-green bands read as "recessed feature zones" between cream/white body sections)
- **SVG filter shadows** on Starbucks-Card visuals add a slight 3D physicality without a box-shadow

## 7. Do's and Don'ts

### Do

- Use Neutral Warm (`#f2f0eb`) or Ceramic (`#edebe9`) as page canvas instead of pure white — the warm cream is the signature
- Map the green tiers to their intended surface role — Starbucks Green for headings, Green Accent for CTAs, House Green for deep bands, Uplift for decorative
- Keep tracking tight at `-0.01em` / `-0.16px` on SoDoSans across the whole system
- Use 50px full-pill radius on every button without exception
- Apply `transform: scale(0.95)` as the universal button active state
- Reserve Gold for Rewards-status ceremony moments only
- Use SoDoSans for nearly everything; switch to Lander Tall serif only for Rewards editorial headlines; reserve Kalam script for Careers "cup name" moments
- Layer 2–3 low-alpha shadows instead of one heavier drop shadow for elevation
- Use the Frap circular CTA as the persistent floating order entry on every shopping surface
- Let the cream canvas breathe between content cards — use whitespace, not dividers

### Don't

- Don't use pure white as the page canvas — the warm cream temperature is load-bearing
- Don't pick "one brand green" — the four-green system is intentional; using only `#006241` everywhere flattens the brand
- Don't use Gold as a general-purpose accent — it's a Rewards signal only
- Don't square the corners on buttons — the 50px pill is universal
- Don't introduce gradient fills — the system is color-block throughout
- Don't weight-contrast h1 and h2 by size — the hierarchy comes from weight + color (600 Starbucks-Green vs 400 Text Black)
- Don't use pure black for body text — `rgba(0,0,0,0.87)` matches the warm canvas
- Don't skip the `scale(0.95)` active feedback on buttons — it's a signature micro-interaction
- Don't stack single heavy shadows; always layer 2–3 low-alpha ones
- Don't introduce serifs or scripts into the main shopping flow — they belong to Rewards and Careers contexts respectively

## 8. Responsive Behavior

### Breakpoints

Inferred from component width tokens and progressive nav heights:

| Name    | Width       | Key Changes                                                                     |
| ------- | ----------- | ------------------------------------------------------------------------------- |
| xs      | < 480px     | Global nav 64px; hamburger menu; single-column layouts; pill buttons full-width |
| Mobile  | 480–767px   | Global nav 72px; gift-card grid 2-up; card padding tightens                     |
| Tablet  | 768–1023px  | Global nav 83px; gift-card grid 3-up; hero split begins to appear               |
| Desktop | 1024–1439px | Global nav 99px; gift-card grid 4-up; full asymmetric hero 40/60                |
| XLarge  | 1440px+     | Content caps at `--columnWidthXLarge`; gift-card grid 5-up; extra cream margin  |

### Touch Targets

- Pill buttons at `7px 16px` padding measure ~32px tall — below 44px WCAG AAA minimum for touch-only surfaces. On mobile, button padding may be visually expanded to meet the minimum.
- Frap floating circular button at `56px` is well above minimum.
- Frap uses `--frapTouchOffset: calc(-1 * .8rem)` to extend tap area 8px beyond visual edge.
- Form float-label inputs grow their label font size on mobile (1.6rem base vs 1.9rem desktop) — easier to tap and read at arm's-length.

### Collapsing Strategy

- **Global nav height scales progressively**: 64 → 72 → 83 → 99px across breakpoints, not a single value
- **Hero split collapses**: 40/60 asymmetric split → stacked (image top, content below) at mobile
- **Gift-card grid**: 5-up → 4-up → 3-up → 2-up → 1-up across breakpoints with adjusted card widths
- **Feature bands**: Stay full-width but text + imagery stack vertically on mobile
- **Outer gutter scales**: 16px → 24px → 40px as viewport grows
- **Rewards 3-column status panels**: Stack to single column on mobile

### Image Behavior

- Hero product photography crops tighter vertically on mobile; content becomes the visual anchor
- Gift-card illustrations preserve aspect ratio; card grid reflows
- `opacity 0.3s ease-in` fade-in transition on image load (prevents jarring pop-in)
- Rewards app-in-hand photography scales proportionally; never stretches
