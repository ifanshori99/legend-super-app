// Cafe Legend public website fixtures: the home page content (brand profile,
// Bandung outlet, opening hours, promoted menu cards, promos, contact and SEO
// metadata) and the full online menu page built from the menu fixtures, so ids
// and prices match the rest of the contracts.
//
// The base URL and image hosts are illustrative; the owner's domain, photos
// and Google Business Profile link replace them before launch. Sample data, not
// final website copy.

import { cafeLegendFixtures, z } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { publicMenuPageSchema, publicSiteSchema } from "./schemas.ts";
import type { PublicMenuPage, PublicSite } from "./schemas.ts";

const { brand, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const siteUrl = "https://cafelegend.id";

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.name === name,
  );
  if (!item) throw new RangeError(`Unknown menu fixture item: ${name}`);
  return item;
};
const priceOf = (menuItemId: string) => {
  const row = cafeLegendMenuFixtures.priceListItems.find(
    (entry) => entry.itemId === menuItemId,
  );
  if (!row) throw new RangeError(`No channel price for item ${menuItemId}`);
  return row.priceIdr;
};

const publishedAt = "2026-11-01T02:00:00.000Z";

const featuredItem = (name: string) => {
  const item = menuItem(name);
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    priceIdr: priceOf(item.id),
    imageUrl: null as string | null,
  };
};

const menuPage: PublicMenuPage = publicMenuPageSchema.parse({
  sections: cafeLegendMenuFixtures.categories
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((category) => ({
      id: category.id,
      name: category.name,
      description: null,
      sortOrder: category.sortOrder,
      items: cafeLegendMenuFixtures.items
        .filter((item) => item.categoryId === category.id && item.isActive)
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          priceIdr: priceOf(item.id),
          imageUrl: null,
          labels: item.labels,
          allergens: item.allergens,
          isAvailable:
            cafeLegendMenuFixtures.availability.find(
              (row) => row.menuItemId === item.id,
            )?.status === "available",
        })),
    })),
  pricesExcludeTaxAndService: true,
  updatedAt: publishedAt,
});

const site: PublicSite = publicSiteSchema.parse({
  brand: {
    id: brand.id,
    slug: brand.slug,
    name: brand.name,
    tagline: "Kopi, dapur, dan ruang berkumpul di jantung Bandung.",
    description:
      "Cafe Legend adalah kafe kopi dan dapur Nusantara di Kota Bandung. Menyediakan kopi single origin, hidangan rumahan, pastry, ruang private room untuk acara, serta area WFC dengan Wi-Fi.",
  },
  outlet: {
    id: outlet.id,
    code: outlet.code,
    name: outlet.name,
    timeZone: outlet.timeZone,
    address: {
      streetLine: "Jl. Braga No. 12",
      district: "Braga",
      city: "Bandung",
      province: "Jawa Barat",
      postalCode: "40111",
      country: "ID",
    },
    geo: { latitude: -6.9147, longitude: 107.6098 },
    mapUrl: "https://maps.google.com/?q=Cafe+Legend+Bandung",
    openingHours: [
      {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        opens: "08:00",
        closes: "23:00",
      },
    ],
  },
  heroImages: [
    {
      url: "https://storage.cafelegend.id/site/hero-outlet.jpg",
      alt: "Ruang utama Cafe Legend dengan meja kayu dan bar kopi",
    },
  ],
  gallery: [
    {
      url: "https://storage.cafelegend.id/site/gallery-bar.jpg",
      alt: "Bar kopi Cafe Legend tempat barista menyeduh manual brew",
    },
    {
      url: "https://storage.cafelegend.id/site/gallery-private-room.jpg",
      alt: "Private Room Nusantara dengan meja panjang untuk delapan tamu",
    },
  ],
  highlights: [
    {
      title: "Kopi single origin",
      description:
        "Biji kopi dari petani Jawa Barat dan Sumatra, disangrai mingguan.",
    },
    {
      title: "Dapur Nusantara",
      description:
        "Menu rumahan seperti nasi goreng kampung dan ayam sambal matah, dimasak saat dipesan.",
    },
    {
      title: "Private room dan acara",
      description:
        "Ruang untuk ulang tahun, arisan, dan pertemuan komunitas dengan paket pre-order.",
    },
  ],
  featuredMenuItems: [
    featuredItem("Kopi Susu Aren"),
    featuredItem("Nasi Goreng Kampung"),
    featuredItem("Croissant Mentega"),
  ],
  promotions: [
    {
      title: "Kopi Senja",
      description:
        "Diskon 20% untuk seluruh minuman kopi setiap hari pukul 15.00–18.00.",
      validUntil: "2026-12-31",
    },
    {
      title: "Paket Rombongan",
      description:
        "Pesan paket Kopi & Pastry untuk minimal enam tamu; reservasi minimal sehari sebelumnya.",
      validUntil: null,
    },
  ],
  contact: {
    whatsapp: "6281222344455",
    email: "halo@cafelegend.id",
    instagramUrl: "https://instagram.com/cafelegend",
    googleBusinessProfileUrl: "https://maps.google.com/?q=Cafe+Legend+Bandung",
  },
  seo: {
    title: "Cafe Legend Bandung — Kopi & Dapur Nusantara",
    description:
      "Kafe kopi dan dapur Nusantara di Jl. Braga, Bandung. Buka 08.00–23.00, tersedia private room, paket acara, dan area WFC.",
    canonicalUrl: `${siteUrl}/`,
    ogImageUrl: "https://storage.cafelegend.id/site/og-home.jpg",
    robots: "index,follow",
    language: "id-ID",
  },
  acceptsReservations: true,
  memberLoginUrl: `${siteUrl}/member`,
  pricesExcludeTaxAndService: true,
  updatedAt: publishedAt,
});

export const websiteFixtureSchema = z.strictObject({
  site: publicSiteSchema,
  menuPage: publicMenuPageSchema,
  /** Absolute URL of the menu page, needed by the Restaurant JSON-LD. */
  menuUrl: z.url(),
});
export type WebsiteFixtures = z.infer<typeof websiteFixtureSchema>;

export const cafeLegendWebsiteFixtures: WebsiteFixtures =
  websiteFixtureSchema.parse({
    site,
    menuPage,
    menuUrl: `${siteUrl}/menu`,
  });

/** The canonical base URL of the fixture site. */
export const cafeLegendWebsiteUrl = siteUrl;
