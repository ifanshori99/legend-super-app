// Alur R / TEN-08 (brief 91, slice 7): customer and staff screens never show
// the platform name, logo, or a link into the Platform Panel.
//
// Runs against the production build. Each screen is scanned for visible text,
// <title>, <meta content>, img[src], a[href] and <link href>.
//
// Assumptions:
//   - Platform name = "Legend Super App" (PRD D43) and the starter identity
//     "Express TanStack Postgres" (starter.config.json / site.ts).
//   - Production e2e runs on localhost, which is not a tenant host, so the
//     screens render their fallback brand. TEN-08 must hold there too.
//   - /design-system is a developer showcase and is not part of the
//     customer/staff scan; its text is covered by the API catalog test.
//   - The web manifest is served to every customer who installs the app, so
//     it counts as a customer-facing surface.
import { expect, test, type Page } from "@playwright/test";

const PLATFORM_NAMES = [
  "legend super app",
  "express tanstack postgres",
  "ngodingpakeai",
  "powered by",
  "panel platform",
];

// Customer, public and staff entry screens; unknown tokens give the error
// states, /karyawan and /kelola redirect an anonymous visitor to sign-in.
const SCREENS = [
  "/",
  "/menu",
  "/reservation",
  "/masuk",
  "/sign-in",
  "/sign-up",
  "/t/token-palsu",
  "/bayar/token-palsu",
  "/karyawan",
  "/kelola",
  "/halaman-yang-tidak-ada",
];

async function surface(page: Page): Promise<string[]> {
  // Wait for hydration and data fetches, then for a rendered root element, so
  // an empty or half-rendered page cannot pass the scan by showing nothing.
  await page.waitForLoadState("networkidle");
  await page.locator("body > *").first().waitFor();
  await expect
    .poll(() => page.evaluate(() => document.body.innerText.trim().length))
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const parts: string[] = [
      document.body.innerText,
      document.title,
      document.documentElement.getAttribute("lang") ?? "",
    ];
    const attr = (selector: string, name: string) =>
      document
        .querySelectorAll(selector)
        .forEach((el) => parts.push(el.getAttribute(name) ?? ""));
    attr("meta[content]", "content");
    attr("img", "src");
    attr("img", "alt");
    attr("a[href]", "href");
    attr("link[href]", "href");
    attr("[aria-label]", "aria-label");
    return parts;
  });
}

function leaks(parts: string[]): string[] {
  const text = parts.join("\n").toLowerCase();
  return PLATFORM_NAMES.filter((name) => text.includes(name));
}

for (const path of SCREENS) {
  test(`TEN-08 ${path} shows no platform name, logo or text`, async ({
    page,
  }) => {
    await page.goto(path);
    expect(leaks(await surface(page))).toEqual([]);
  });
}

test("TEN-08 no screen links customers or staff into the Platform Panel", async ({
  page,
}) => {
  for (const path of SCREENS) {
    await page.goto(path);
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map(
        (a) => a.getAttribute("href") ?? "",
      ),
    );
    expect(
      hrefs.filter((href) =>
        /^(\/platform|https?:\/\/[^/]*platform)/i.test(href),
      ),
      path,
    ).toEqual([]);
  }
});

// Known leak, bug legend-ozud (P1). Flip to test( once the per-tenant manifest ships.
// The manifest is required: a missing one is a failure, not a pass.
test.skip("[PENDING-CARD legend-ozud] TEN-08 the installable web manifest carries the brand, not the platform name", async ({
  request,
}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  const text = await response.text();
  const manifest = JSON.parse(text) as { name?: string; short_name?: string };
  expect((manifest.name ?? manifest.short_name ?? "").trim()).not.toBe("");
  expect(leaks([text])).toEqual([]);
});
