// Public brand website FE logic (bead legend-qflm; PRD v1.7 §3.24 F21 "Website
// Publik per Brand", §3.24 SEO Lokal, TEN-08). Pure helpers only: the route
// head builders, opening-hours formatting, sitemap/robots markup and the
// reservation entry rules, loaded with plain Node type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as site from "../packages/shared/src/website/index.ts";
import * as seo from "../apps/web/src/features/ws08-website/lib/seo.ts";
import * as hours from "../apps/web/src/features/ws08-website/lib/hours.ts";
import * as reservation from "../apps/web/src/features/ws08-website/lib/reservation.ts";

const fixtures = site.cafeLegendWebsiteFixtures;
const homepage = fixtures.site;
const menuPage = fixtures.menuPage;
const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

test("F21 home head carries the brand SEO metadata and Restaurant JSON-LD", () => {
  const menuUrl = seo.absoluteUrl(homepage.seo.canonicalUrl, "/menu");
  const head = seo.homeHead(homepage, menuUrl);
  const meta = (name) =>
    head.meta.find((entry) => entry.name === name || entry.property === name)
      ?.content;

  assert.equal(head.meta[0].title, homepage.seo.title);
  assert.equal(meta("description"), homepage.seo.description);
  assert.equal(meta("robots"), "index,follow");
  assert.equal(meta("og:url"), homepage.seo.canonicalUrl);
  assert.equal(meta("og:site_name"), homepage.brand.name);
  assert.equal(meta("og:image"), homepage.seo.ogImageUrl);
  assert.deepEqual(head.links, [
    { rel: "canonical", href: homepage.seo.canonicalUrl },
  ]);

  assert.equal(head.scripts.length, 1);
  assert.equal(head.scripts[0].type, "application/ld+json");
  const jsonLd = JSON.parse(head.scripts[0].children);
  site.restaurantJsonLdSchema.parse(jsonLd);
  assert.equal(jsonLd["@type"], "Restaurant");
  assert.equal(jsonLd.hasMenu, menuUrl);
  assert.equal(jsonLd.telephone, `+${homepage.contact.whatsapp}`);
  // TEN-08: the page speaks for the brand only; no platform URL anywhere.
  assert.equal(JSON.stringify(jsonLd).includes("legend-super-app"), false);
});

test("F21 menu head is the menu page's own canonical and Menu JSON-LD", () => {
  const head = seo.menuHead(homepage, menuPage, {
    title: "Menu Cafe Legend",
    description: "Menu lengkap Cafe Legend.",
    jsonLdName: "Menu Cafe Legend",
  });
  const canonical = `${new URL(homepage.seo.canonicalUrl).origin}/menu`;
  assert.equal(head.meta[0].title, "Menu Cafe Legend");
  assert.deepEqual(head.links, [{ rel: "canonical", href: canonical }]);
  const jsonLd = JSON.parse(head.scripts[0].children);
  site.menuJsonLdSchema.parse(jsonLd);
  assert.equal(jsonLd["@type"], "Menu");
  assert.equal(
    jsonLd.hasMenuSection.length,
    menuPage.sections.filter((section) => section.items.length > 0).length,
  );
  // Prices are whole-rupiah strings, the form schema.org Offer.price expects.
  for (const section of jsonLd.hasMenuSection)
    for (const item of section.hasMenuItem)
      assert.match(item.offers.price, /^[0-9]+$/);
});

test("F21 JSON-LD cannot close the script tag from a menu item name", () => {
  const hostile = structuredClone(menuPage);
  hostile.sections[0].items[0].name = "</script><script>alert(1)</script>";
  const head = seo.menuHead(homepage, hostile, {
    title: "Menu",
    description: "Menu.",
    jsonLdName: "Menu",
  });
  const serialized = head.scripts[0].children;
  assert.equal(serialized.includes("</script>"), false);
  assert.deepEqual(
    JSON.parse(serialized).hasMenuSection[0].hasMenuItem[0].name,
    "</script><script>alert(1)</script>",
  );
});

test("F21 sitemap.xml lists home, menu, reservation and member from the canonical origin", () => {
  const xml = seo.sitemapXml(homepage);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(
    xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'),
  );
  for (const path of ["/", "/menu", "/reservation", "/member"])
    assert.ok(
      xml.includes(
        `<loc>${new URL(homepage.seo.canonicalUrl).origin}${path}</loc>`,
      ),
      path,
    );
  assert.equal((xml.match(/<url>/g) ?? []).length, 4);
  assert.ok(xml.includes(`<lastmod>${homepage.updatedAt}</lastmod>`));
  assert.ok(xml.includes("<priority>1.0</priority>"));
});

test("F21 robots.txt allows the brand pages and hides signed-in areas", () => {
  const robots = seo.robotsTxt(homepage.seo.canonicalUrl);
  const origin = new URL(homepage.seo.canonicalUrl).origin;
  assert.ok(robots.startsWith("User-agent: *\nAllow: /\n"));
  assert.ok(robots.includes("Disallow: /member"));
  assert.ok(robots.includes("Disallow: /kelola"));
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
});

test("F21 opening hours group identical ranges into readable lines", () => {
  assert.deepEqual(
    hours.openingHoursLines(homepage.outlet.openingHours, {
      days: DAYS,
      everyDay: "Setiap hari",
    }),
    ["Setiap hari, 08.00–23.00"],
  );

  const split = [
    { daysOfWeek: [1, 2, 3, 4, 5], opens: "08:00", closes: "22:00" },
    { daysOfWeek: [6, 0], opens: "09:00", closes: "23:00" },
  ];
  assert.deepEqual(
    hours.openingHoursLines(split, { days: DAYS, everyDay: "Setiap hari" }),
    ["Senin–Jumat, 08.00–22.00", "Sabtu–Minggu, 09.00–23.00"],
  );
  // Two non-adjacent days sharing one range list both names, Monday first.
  assert.deepEqual(
    hours
      .groupOpeningHours([
        { daysOfWeek: [6, 1], opens: "10:00", closes: "12:00" },
      ])
      .map((group) => group.days),
    [[1, 6]],
  );
});

test("F21 dates format in UTC so SSR and the browser agree", () => {
  assert.equal(hours.formatBusinessDate("2026-12-31"), "31 Desember 2026");
  assert.equal(
    hours.formatIsoDate("2026-11-01T02:00:00.000Z"),
    "1 November 2026",
  );
  assert.equal(hours.formatBusinessDate("not-a-date"), "");
});

test("F21 reservation entry validates name, date, time, pax and notes", () => {
  const today = "2026-11-02";
  const valid = reservation.validateReservationRequest(
    {
      name: "  Sari  ",
      date: "2026-11-03",
      time: "19:30",
      pax: "4",
      notes: " Meja dekat jendela ",
    },
    today,
  );
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, {
    name: "Sari",
    date: "2026-11-03",
    time: "19:30",
    pax: 4,
    notes: "Meja dekat jendela",
  });

  const past = reservation.validateReservationRequest(
    { name: "Sari", date: "2026-11-01", time: "19:30", pax: "4", notes: "" },
    today,
  );
  assert.deepEqual(past, { ok: false, errors: { date: true } });

  const broken = reservation.validateReservationRequest(
    { name: "S", date: "", time: "25:00", pax: "0", notes: "x".repeat(301) },
    today,
  );
  assert.deepEqual(broken, {
    ok: false,
    errors: { name: true, date: true, time: true, pax: true, notes: true },
  });
});

test("F21 reservation WhatsApp link encodes the message and rejects bad numbers", () => {
  const url = reservation.buildWhatsAppUrl(
    homepage.contact.whatsapp,
    "Halo Cafe Legend\nNama: Sari & Budi",
  );
  assert.ok(url.startsWith(`https://wa.me/${homepage.contact.whatsapp}?text=`));
  assert.equal(
    new URL(url).searchParams.get("text"),
    "Halo Cafe Legend\nNama: Sari & Budi",
  );
  assert.equal(reservation.buildWhatsAppUrl("+62 812", "x"), null);
  assert.equal(reservation.buildWhatsAppUrl("", "x"), null);
});
