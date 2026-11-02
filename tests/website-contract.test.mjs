// Public brand website contract tests (bead legend-m7ak). PRD v1.7 §3 F21 /
// §3.24 "Website Publik per Brand": home page, online menu, SEO metadata,
// JSON-LD Restaurant + Menu and the sitemap.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as site from "../packages/shared/src/website/index.ts";

const f = site.cafeLegendWebsiteFixtures;
const homepage = f.site;
const menuPage = f.menuPage;

test("F21 Cafe Legend website fixtures parse (§3.24 home and online menu)", () => {
  site.websiteFixtureSchema.parse(f);
  assert.equal(homepage.brand.name, "Cafe Legend");
  assert.equal(homepage.outlet.code, "BDG-01");
  assert.equal(homepage.outlet.address.country, "ID");
  assert.equal(homepage.outlet.openingHours[0].opens, "08:00");
  assert.equal(homepage.acceptsReservations, true);
  assert.ok(homepage.memberLoginUrl.startsWith("https://"));
  assert.ok(homepage.featuredMenuItems.length >= 3);
  assert.ok(homepage.promotions.length >= 1);
  assert.equal(menuPage.sections.length, 4);
  const menuItems = menuPage.sections.flatMap((section) => section.items);
  assert.ok(menuItems.length >= 60, `found ${menuItems.length} menu items`);
  for (const item of menuItems) {
    assert.ok(item.priceIdr > 0, item.name);
    assert.equal(typeof item.isAvailable, "boolean");
  }
  // The featured cards are real menu items with the same price as the menu page.
  for (const featured of homepage.featuredMenuItems) {
    const onMenu = menuItems.find((item) => item.id === featured.id);
    assert.ok(onMenu, featured.name);
    assert.equal(featured.priceIdr, onMenu.priceIdr);
  }
});

test("F21 online menu prices exclude tax and service charge (owner decision)", () => {
  assert.equal(menuPage.pricesExcludeTaxAndService, true);
  assert.equal(homepage.pricesExcludeTaxAndService, true);
  // The disclosure is a contract fact, not optional copy: false is invalid.
  assert.equal(
    site.publicMenuPageSchema.safeParse({
      ...menuPage,
      pricesExcludeTaxAndService: false,
    }).success,
    false,
  );
  assert.equal(
    site.publicSiteSchema.safeParse({
      ...homepage,
      pricesExcludeTaxAndService: false,
    }).success,
    false,
  );
});

test("F21 Restaurant JSON-LD carries address, geo, hours, menu and reservations", () => {
  const jsonLd = site.buildRestaurantJsonLd(homepage, f.menuUrl);
  site.restaurantJsonLdSchema.parse(jsonLd);
  assert.equal(jsonLd["@context"], "https://schema.org");
  assert.equal(jsonLd["@type"], "Restaurant");
  assert.equal(jsonLd.name, "Cafe Legend Bandung");
  assert.equal(jsonLd.address.addressCountry, "ID");
  assert.equal(jsonLd.geo.latitude, homepage.outlet.geo.latitude);
  assert.equal(jsonLd.openingHoursSpecification.length, 1);
  assert.deepEqual(jsonLd.openingHoursSpecification[0].dayOfWeek, [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]);
  assert.equal(jsonLd.hasMenu, f.menuUrl);
  assert.equal(jsonLd.acceptsReservations, true);
  assert.ok(jsonLd.sameAs.includes(homepage.contact.instagramUrl));
  assert.ok(jsonLd.sameAs.includes(homepage.contact.googleBusinessProfileUrl));
  assert.equal(jsonLd.telephone, `+${homepage.contact.whatsapp}`);
});

test("F21 Menu JSON-LD prices are whole-rupiah strings and sold-out items are OutOfStock", () => {
  const jsonLd = site.buildMenuJsonLd(menuPage, "Menu Cafe Legend");
  site.menuJsonLdSchema.parse(jsonLd);
  assert.equal(jsonLd["@type"], "Menu");
  assert.equal(jsonLd.hasMenuSection.length, menuPage.sections.length);
  const firstSection = jsonLd.hasMenuSection[0];
  assert.equal(
    firstSection.hasMenuItem.length,
    menuPage.sections[0].items.length,
  );
  const firstItem = firstSection.hasMenuItem[0];
  assert.match(firstItem.offers.price, /^[0-9]+$/);
  assert.equal(firstItem.offers.priceCurrency, "IDR");
  assert.equal(firstItem.offers.availability, "https://schema.org/InStock");

  // An item that runs out is advertised as OutOfStock, not removed silently.
  const soldOut = structuredClone(menuPage);
  soldOut.sections[0].items[0].isAvailable = false;
  const soldOutJsonLd = site.buildMenuJsonLd(soldOut, "Menu Cafe Legend");
  assert.equal(
    soldOutJsonLd.hasMenuSection[0].hasMenuItem[0].offers.availability,
    "https://schema.org/OutOfStock",
  );
});

test("F21 JSON-LD serialization is safe inside an SSR script tag", () => {
  const hostile = {
    "@context": "https://schema.org",
    name: "</script><script>alert('x')</script>",
  };
  const serialized = site.serializeJsonLd(hostile);
  assert.equal(serialized.includes("</script>"), false);
  assert.ok(serialized.includes("\\u003c/script"));
  // The escape is still valid JSON with the original text.
  assert.deepEqual(JSON.parse(serialized), hostile);
});

test("F21 sitemap entries cover the home, menu and reservation routes, never the sign-in member page (legend-d6g5)", () => {
  const entries = site.sitemapEntriesFor(homepage);
  for (const entry of entries) site.sitemapEntrySchema.parse(entry);
  assert.deepEqual(
    entries.map((entry) => new URL(entry.loc).pathname),
    ["/", "/menu", "/reservation"],
  );
  // PRD §5: /member needs sign-in and robots.txt disallows it, so submitting it
  // would only report "Submitted URL blocked by robots.txt" (legend-d6g5).
  assert.equal(
    entries.some((entry) => new URL(entry.loc).pathname === "/member"),
    false,
  );
  assert.equal(entries[0].priority, 1);
  for (const entry of entries) {
    assert.ok(entry.loc.startsWith("https://cafelegend.id/"), entry.loc);
    assert.equal(entry.lastModified, homepage.updatedAt);
  }
  // Routes match the site contract.
  assert.deepEqual(site.PUBLIC_SITE_ROUTES, {
    home: "/",
    menu: "/menu",
    reservation: "/reservation",
    member: "/member",
  });
});

test("F21 SEO metadata respects the snippet budgets", () => {
  assert.ok(homepage.seo.title.length <= 60);
  assert.ok(homepage.seo.description.length <= 160);
  assert.equal(homepage.seo.robots, "index,follow");
  assert.equal(homepage.seo.language, "id-ID");
  assert.equal(
    site.seoMetaSchema.safeParse({
      ...homepage.seo,
      title: "x".repeat(61),
    }).success,
    false,
  );
  assert.equal(
    site.seoMetaSchema.safeParse({
      ...homepage.seo,
      description: "x".repeat(161),
    }).success,
    false,
  );
  assert.equal(
    site.seoMetaSchema.safeParse({
      ...homepage.seo,
      canonicalUrl: "http://cafelegend.id/",
    }).success,
    false,
  );
});

test("website endpoints are the two public read routes", () => {
  const endpoints = Object.values(site).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.method === "string" &&
      typeof value.path === "string" &&
      value.id === `${value.method} ${value.path}`,
  );
  assert.deepEqual(endpoints.map((endpoint) => endpoint.path).sort(), [
    "/api/public/site",
    "/api/public/site/menu",
  ]);
  for (const endpoint of endpoints) {
    assert.equal(endpoint.method, "GET");
    // Public routes carry no tenant or outlet parameter (D-CORE-3).
    assert.equal(endpoint.params, undefined);
    assert.equal(endpoint.query, undefined);
  }
});
