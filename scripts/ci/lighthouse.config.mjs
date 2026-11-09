// Lighthouse budget for the guest-facing pages (PRD NFR; bead legend-wwsa).
// Read by scripts/ci/lighthouse.mjs and unit-tested through
// scripts/ci/lighthouse-evaluate.mjs. Change a number here, not in the runner.
//
// Preset: Lighthouse's mobile defaults (Moto G Power, simulated slow 4G, 4x CPU
// slowdown), because guests scan a table QR on a phone. Each page runs `runs`
// times and the median of every score and metric is compared, so one noisy run
// on a shared CI runner cannot fail the build on its own.
//
// The ambitions are deliberately a little looser than Lighthouse's "good" bands
// (LCP 2.5 s, TBT 200 ms) because the pages are measured against a production
// build on a 2-core CI runner. Tighten them once a baseline of real runs exists.

/** Median-of-N run count. Odd, so the median is a real run, not an average. */
export const runs = 3;

/** Pages measured. `{token}` is replaced with a real signed table QR token. */
export const pages = [
  {
    name: "menu",
    path: "/menu",
    description: "Public brand website menu",
    categories: {},
  },
  {
    name: "table-menu",
    path: "/t/{token}",
    description: "Guest QR ordering menu for a table",
    // The QR ordering area is an operational, session-bound area that is not
    // indexed (PRD section 5, "Diindeks: Tidak"), so an SEO score would only
    // measure the robots rules. `null` removes the category for this page.
    categories: { seo: null },
  },
];

/**
 * Minimum category score, 0..1 (Lighthouse reports 0..100; 0.9 means 90).
 * performance is the noisy one on CI, so it has the lowest floor.
 */
export const categories = {
  performance: 0.8,
  accessibility: 0.9,
  "best-practices": 0.9,
  seo: 0.9,
};

/**
 * Maximum value of the key lab metrics (the ones Core Web Vitals care about).
 *   largest-contentful-paint  ms   Lighthouse "good" 2500, "poor" 4000
 *   cumulative-layout-shift   unitless, "good" 0.1, "poor" 0.25
 *   total-blocking-time       ms   (lab proxy for INP) "good" 200, "poor" 600
 */
export const metrics = {
  "largest-contentful-paint": 3500,
  "cumulative-layout-shift": 0.1,
  "total-blocking-time": 400,
};

/** Hostname of the seeded Cafe Legend platform domain (tenant resolution is by Host). */
export const tenantHostname = "cafe-legend.platform.example";

/**
 * Same ports as playwright.config.ts. The web bundle inlines VITE_API_URL at
 * build time, so build with VITE_API_URL=http://localhost:4101 (what
 * `pnpm test:e2e` does) and the turbo cache is shared with that build.
 */
export const ports = { api: 4101, web: 3101 };
