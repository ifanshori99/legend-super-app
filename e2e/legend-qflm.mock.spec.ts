// Public brand website (bead legend-qflm; PRD v1.7 §3.24 F21 "Website Publik
// per Brand", TEN-08) against mock mode: the website fixtures from
// @starter/shared/website, the SEO head, JSON-LD, sitemap/robots and the
// reservation entry form. Acceptance IDs live in the test names.
import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

declare global {
  interface Window {
    /** Declared by the mock runtime; other specs widen it the same way. */
    __legendMock?: { setScenario: (scenario: string) => void };
    __TSR_ROUTER__?: { navigate: (options: { to: string }) => Promise<void> };
  }
}

/** Client-side navigation, so the mock scenario applies to the fetch. */
async function navigateClient(
  page: import("@playwright/test").Page,
  to: string,
) {
  await waitForHydration(page);
  await page.evaluate(
    (path) => window.__TSR_ROUTER__?.navigate({ to: path }),
    to,
  );
}

const SITE_TITLE = "Cafe Legend Bandung — Kopi & Dapur Nusantara";

/** Demo photos are served from apps/web/demo, mock mode only (legend-6vki). */
const DEMO_PHOTO = "/sample/menu/";

test("F21 home shows the brand profile, hours, location, featured menu and promos", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Cafe Legend" }),
  ).toBeVisible();
  // Brand identity comes from the site payload (TEN-08), never the platform.
  await expect(
    page.getByText("Setiap hari, 08.00–23.00").first(),
  ).toBeVisible();
  await expect(page.getByText("Jl. Braga No. 12").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Menu unggulan" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Susu Aren").first()).toBeVisible();
  await expect(page.getByText("Nasi Goreng Kampung").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Promo berjalan" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Senja").first()).toBeVisible();
  // Photo-first (Q23/Q24): demo photos load in mock mode.
  const sources = await page
    .locator("img")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  expect(sources.length).toBeGreaterThanOrEqual(3);
  expect(sources.every((src) => src?.startsWith(DEMO_PHOTO))).toBe(true);
});

test("F21 home head carries SEO meta, canonical and Restaurant JSON-LD", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(SITE_TITLE);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /Kafe kopi dan dapur Nusantara/,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://cafelegend.id/",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /og-home/,
  );

  const jsonLd = JSON.parse(
    (await page
      .locator('script[type="application/ld+json"]')
      .first()
      .textContent()) ?? "{}",
  );
  expect(jsonLd["@context"]).toBe("https://schema.org");
  expect(jsonLd["@type"]).toBe("Restaurant");
  expect(jsonLd.name).toBe("Cafe Legend Bandung");
  expect(jsonLd.telephone).toBe("+6281222344455");
  expect(jsonLd.hasMenu).toBe("https://cafelegend.id/menu");
  expect(jsonLd.acceptsReservations).toBe(true);
  expect(jsonLd.openingHoursSpecification[0].opens).toBe("08:00");
  expect(jsonLd.sameAs).toContain(
    "https://maps.google.com/?q=Cafe+Legend+Bandung",
  );
});

test("F21 online menu lists every section with the tax disclosure and Menu JSON-LD", async ({
  page,
}) => {
  await page.goto("/menu");
  await expect(page).toHaveTitle("Menu Cafe Legend");
  for (const section of ["Kopi", "Nonkopi", "Dapur", "Pastry"])
    await expect(
      page.getByRole("heading", { level: 2, name: section, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("Harga belum termasuk pajak dan service charge."),
  ).toBeVisible();
  // Prices are formatted rupiah, not raw numbers.
  await expect(page.getByText(/Rp\s?\d[\d.]*/).first()).toBeVisible();

  const jsonLd = JSON.parse(
    (await page
      .locator('script[type="application/ld+json"]')
      .first()
      .textContent()) ?? "{}",
  );
  expect(jsonLd["@type"]).toBe("Menu");
  expect(jsonLd.hasMenuSection).toHaveLength(4);
  const offer = jsonLd.hasMenuSection[0].hasMenuItem[0].offers;
  expect(offer.priceCurrency).toBe("IDR");
  expect(offer.price).toMatch(/^[0-9]+$/);
});

test("F21 menu search filters items and offers a way back to the full list", async ({
  page,
}) => {
  await page.goto("/menu");
  await waitForHydration(page);
  const search = page.getByRole("searchbox", { name: "Cari menu" });
  await search.fill("nasi goreng");
  await expect(
    page.getByRole("heading", { name: "Nasi Goreng Kampung" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cappuccino", exact: true }),
  ).toHaveCount(0);

  await search.fill("zzz bukan menu");
  await expect(page.getByText("Menu tidak ditemukan")).toBeVisible();
  await page.getByRole("button", { name: "Tampilkan semua menu" }).click();
  await expect(
    page.getByRole("heading", { name: "Cappuccino", exact: true }),
  ).toBeVisible();
});

test("F21 sitemap.xml lists the three public routes and robots.txt points at it (legend-d6g5)", async ({
  request,
}) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const xml = await sitemap.text();
  for (const path of ["/", "/menu", "/reservation"])
    expect(xml).toContain(`<loc>https://cafelegend.id${path}</loc>`);
  // PRD §5: /member needs sign-in and is disallowed in robots.txt below, so the
  // sitemap must not submit it (Search Console "blocked by robots.txt").
  expect(xml).not.toContain("<loc>https://cafelegend.id/member</loc>");
  expect(xml).toContain("<lastmod>2026-11-01T02:00:00.000Z</lastmod>");

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const text = await robots.text();
  expect(text).toContain("User-agent: *");
  expect(text).toContain("Disallow: /member");
  expect(text).toContain("Disallow: /kelola");
  expect(text).toContain("Sitemap: https://cafelegend.id/sitemap.xml");
});

test("TEN-08 the public site never shows the platform name or staff links", async ({
  page,
}) => {
  for (const path of ["/", "/menu", "/reservation"]) {
    await page.goto(path);
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toContain("legend super app");
    expect(body).not.toContain("platform operasional");
    expect(
      await page.locator('a[href^="/kelola"], a[href^="/pos"]').count(),
    ).toBe(0);
  }
  // Contact and GBP link come from the brand payload (PRD F21 "GBP link").
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /Google Business Profile/ }).first(),
  ).toHaveAttribute("href", /maps\.google\.com/);
});

test("F21 reservation entry validates the form and builds the WhatsApp request", async ({
  page,
}) => {
  // Client navigation renders the form already hydrated, so every fill lands
  // in React state (a pre-hydration fill is not picked up).
  await page.goto("/");
  await navigateClient(page, "/reservation");
  await expect(
    page.getByRole("heading", { level: 1, name: "Reservasi meja" }),
  ).toBeVisible();

  // An empty name keeps the guest on the page with a fix-it error.
  const submit = page.getByRole("link", { name: "Kirim lewat WhatsApp" });
  await page.locator('input[name="date"]').fill("2026-12-24");
  await page.locator('input[name="time"]').fill("19:30");
  await submit.click();
  await expect(
    page.getByText("Isi nama pemesan minimal 2 karakter."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/reservation$/);

  await page.locator('input[name="name"]').fill("Sari Wulandari");
  await page.locator('input[name="pax"]').fill("4");
  await page
    .locator('textarea[name="notes"]')
    .fill("Meja dekat jendela untuk ulang tahun");
  const href = await submit.getAttribute("href");
  expect(href).toContain("https://wa.me/6281222344455?text=");
  const text = new URL(href ?? "").searchParams.get("text") ?? "";
  expect(text).toContain("Halo Cafe Legend, saya ingin reservasi meja.");
  expect(text).toContain("Nama: Sari Wulandari");
  expect(text).toContain("Tanggal: 24 Desember 2026");
  expect(text).toContain("Jam: 19:30");
  expect(text).toContain("Jumlah tamu: 4");
  expect(text).toContain("Catatan: Meja dekat jendela untuk ulang tahun");
});

test("F21 empty fixtures show the honest empty states, not blank sections", async ({
  page,
}) => {
  // The scenario must exist before the mock transport installs its controls,
  // so seed it through localStorage and then navigate on the client: SSR keeps
  // the normal fixtures, the client fetch sees the empty ones.
  await page.addInitScript(() =>
    window.localStorage.setItem("legend-mock-scenario", "empty"),
  );
  // Start on a page that does not fetch the site payload, so the first client
  // navigation is the one that loads the empty fixtures (an SSR page would
  // already have the normal ones in the query cache).
  await page.goto("/masuk");
  await waitForHydration(page);

  await navigateClient(page, "/");
  await expect(page.getByText("Menu unggulan belum dipilih")).toBeVisible();
  await expect(page.getByText("Belum ada promo")).toBeVisible();

  await navigateClient(page, "/menu");
  await expect(page.getByText("Menu belum tersedia")).toBeVisible();

  await navigateClient(page, "/reservation");
  await expect(page.getByText("Reservasi online belum dibuka")).toBeVisible();
  await page.evaluate(() => window.__legendMock?.setScenario("normal"));
});

test("F21 offline fetch shows the offline state and retry recovers", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("legend-mock-scenario", "offline"),
  );
  await page.goto("/");
  await waitForHydration(page);
  await navigateClient(page, "/menu");
  await expect(page.getByText("Kamu sedang offline")).toBeVisible();

  await page.evaluate(() => window.__legendMock?.setScenario("normal"));
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Menu" }),
  ).toBeVisible();
});
