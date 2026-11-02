// Demo photos for the sample website (DESIGN.md v2 Q23/Q24, v3 §4 "Media").
//
// Every real menu item has a photo and the menu contract refuses publishing
// without one, but the shared fixtures carry `imageUrl: null` (no uploads
// exist). Mock mode therefore overlays Unsplash-licensed samples from
// `apps/web/public/sample/menu/` — the same folder the QR menu uses — so the
// brand site demonstrates the photo-first layout offline. A normal build has
// `API_MOCK = false`, so these paths never reach production and the page
// renders only what the API sends.
import { API_MOCK } from "@/lib/api/mock-flag.ts";

/**
 * One photo stands in for a family of items (the QR menu does the same), so
 * the sample menu never pretends to have a different photo per drink. Keys are
 * the fixture item names; an item missing here has no demo photo at all.
 */
const MENU_PHOTOS: Record<string, string> = {
  // Hot milk-espresso family: one latte-art cup.
  Espresso: "/sample/menu/cappuccino.jpg",
  Americano: "/sample/menu/cappuccino.jpg",
  Cappuccino: "/sample/menu/cappuccino.jpg",
  "Cafe Latte": "/sample/menu/cappuccino.jpg",
  "Flat White": "/sample/menu/cappuccino.jpg",
  Mocha: "/sample/menu/cappuccino.jpg",
  "Caramel Latte": "/sample/menu/cappuccino.jpg",
  "Vanilla Latte": "/sample/menu/cappuccino.jpg",
  "Kopi Tubruk": "/sample/menu/cappuccino.jpg",
  Piccolo: "/sample/menu/cappuccino.jpg",
  "Long Black": "/sample/menu/cappuccino.jpg",
  "Paket Kopi dan Croissant": "/sample/menu/cappuccino.jpg",
  "Cokelat Panas": "/sample/menu/cappuccino.jpg",
  "Matcha Latte": "/sample/menu/cappuccino.jpg",
  "Taro Latte": "/sample/menu/cappuccino.jpg",
  "Red Velvet Latte": "/sample/menu/cappuccino.jpg",
  // Iced coffee family: one iced milk-coffee glass.
  "Kopi Susu Aren": "/sample/menu/es-kopi-susu.jpg",
  "Cold Brew": "/sample/menu/es-kopi-susu.jpg",
  "Vietnam Drip": "/sample/menu/es-kopi-susu.jpg",
  Affogato: "/sample/menu/es-kopi-susu.jpg",
  "Es Cokelat": "/sample/menu/es-kopi-susu.jpg",
  // Tea and cold drinks.
  "Teh Tarik": "/sample/menu/teh-melati.jpg",
  "Lemon Tea": "/sample/menu/teh-melati.jpg",
  "Lychee Tea": "/sample/menu/teh-melati.jpg",
  "Peach Tea": "/sample/menu/teh-melati.jpg",
  "Thai Tea": "/sample/menu/teh-melati.jpg",
  "Jus Jeruk": "/sample/menu/teh-melati.jpg",
  "Jus Alpukat": "/sample/menu/teh-melati.jpg",
  "Jus Mangga": "/sample/menu/teh-melati.jpg",
  "Soda Leci": "/sample/menu/teh-melati.jpg",
  // Kitchen: rice plates and the fried sides.
  "Nasi Goreng Kampung": "/sample/menu/nasi-goreng.jpg",
  "Nasi Goreng Ayam": "/sample/menu/nasi-goreng.jpg",
  "Rice Bowl Teriyaki": "/sample/menu/nasi-goreng.jpg",
  "Ayam Sambal Matah": "/sample/menu/nasi-goreng.jpg",
  "Ayam Geprek": "/sample/menu/nasi-goreng.jpg",
  "Sate Ayam": "/sample/menu/nasi-goreng.jpg",
  "Burger Sapi": "/sample/menu/nasi-goreng.jpg",
  "Kentang Goreng": "/sample/menu/nasi-goreng.jpg",
  "Salad Sayur": "/sample/menu/nasi-goreng.jpg",
  // Noodles and soups.
  "Mie Goreng Jawa": "/sample/menu/mie-kuah.jpg",
  "Mie Kuah": "/sample/menu/mie-kuah.jpg",
  "Soto Ayam": "/sample/menu/mie-kuah.jpg",
  "Sup Buntut": "/sample/menu/mie-kuah.jpg",
  "Pasta Aglio Olio": "/sample/menu/mie-kuah.jpg",
  "Pasta Carbonara": "/sample/menu/mie-kuah.jpg",
  // Bakery: croissants and toasted bread.
  "Croissant Mentega": "/sample/menu/croissant.jpg",
  "Croissant Cokelat": "/sample/menu/croissant.jpg",
  "Roti Bakar Cokelat": "/sample/menu/croissant.jpg",
  "Roti Bakar Keju": "/sample/menu/croissant.jpg",
  "Banana Bread": "/sample/menu/croissant.jpg",
  // Sweets.
  Brownies: "/sample/menu/dessert.jpg",
  Cheesecake: "/sample/menu/dessert.jpg",
  Tiramisu: "/sample/menu/dessert.jpg",
  "Donat Gula": "/sample/menu/dessert.jpg",
  "Donat Cokelat": "/sample/menu/dessert.jpg",
  "Muffin Pisang": "/sample/menu/dessert.jpg",
  "Muffin Cokelat": "/sample/menu/dessert.jpg",
  "Kue Wortel": "/sample/menu/dessert.jpg",
  "Cookies Cokelat": "/sample/menu/dessert.jpg",
  "Pie Apel": "/sample/menu/dessert.jpg",
};

/** Demo photo for a menu item name, or null outside mock mode. */
export function demoMenuPhoto(name: string): string | null {
  return API_MOCK ? (MENU_PHOTOS[name] ?? null) : null;
}

/** Hero sample: a cafe table set for coffee (alt text comes from the catalog). */
export function demoHeroPhoto(): string | null {
  return API_MOCK ? "/sample/menu/cafe-hero.jpg" : null;
}

/** Gallery samples in display order (alt text comes from the catalog). */
export function demoGalleryPhotos(): string[] {
  return API_MOCK
    ? ["/sample/menu/cafe-hero.jpg", "/sample/menu/es-kopi-susu.jpg"]
    : [];
}
