// Demo photos for the sample catalogue (DESIGN.md §4 "Media", owner Q17/Q23/Q24).
//
// Unsplash-licensed images under `apps/web/demo/sample/menu` (outside
// `public/`, so a production build never ships them), served only while the
// demo runs on fixtures (the screens carry the "Contoh data" label).
// This module is MOCK/DEMO ONLY: only `features/*/mock.ts` and the QR mock
// engine import it, so a normal build (VITE_API_MOCK unset) compiles the map
// and its `/sample/menu/...` paths out of the client bundle, and the demo
// folder is not part of the production web output. Production data never uses
// these paths: real outlets serve their own uploads, and the menu contract
// refuses publishing an item without a photo (owner Q23).
//
// One photo may stand in for a family of items (all hot milk-espresso drinks
// share the latte-art cup), so the demo does not pretend to own a different
// photo per drink. Every fixture item name maps to one, so the sample menu and
// the back office show a photo for all 61 demo items.
export const demoPhotos: Record<string, string> = {
  // Kopi: black coffee, the milk-espresso family and iced coffee.
  Espresso: "/sample/menu/espresso.jpg",
  Americano: "/sample/menu/espresso.jpg",
  Cappuccino: "/sample/menu/cappuccino.jpg",
  "Cafe Latte": "/sample/menu/cappuccino.jpg",
  "Kopi Susu Aren": "/sample/menu/es-kopi-susu.jpg",
  "Flat White": "/sample/menu/cappuccino.jpg",
  Mocha: "/sample/menu/cappuccino.jpg",
  "Caramel Latte": "/sample/menu/cappuccino.jpg",
  "Vanilla Latte": "/sample/menu/cappuccino.jpg",
  "Cold Brew": "/sample/menu/cold-brew.jpg",
  "Kopi Tubruk": "/sample/menu/espresso.jpg",
  "Vietnam Drip": "/sample/menu/cold-brew.jpg",
  Affogato: "/sample/menu/affogato.jpg",
  Piccolo: "/sample/menu/cappuccino.jpg",
  "Long Black": "/sample/menu/espresso.jpg",

  // Nonkopi: chocolate, tea and juices.
  "Cokelat Panas": "/sample/menu/hot-chocolate.jpg",
  "Es Cokelat": "/sample/menu/iced-chocolate.jpg",
  "Matcha Latte": "/sample/menu/matcha-latte.jpg",
  "Taro Latte": "/sample/menu/taro-latte.jpg",
  "Red Velvet Latte": "/sample/menu/red-velvet-latte.jpg",
  "Teh Tarik": "/sample/menu/teh-melati.jpg",
  "Lemon Tea": "/sample/menu/lemon-tea.jpg",
  "Lychee Tea": "/sample/menu/iced-tea.jpg",
  "Peach Tea": "/sample/menu/iced-tea.jpg",
  "Thai Tea": "/sample/menu/thai-tea.jpg",
  "Air Mineral": "/sample/menu/air-mineral.jpg",
  "Jus Jeruk": "/sample/menu/jus-jeruk.jpg",
  "Jus Alpukat": "/sample/menu/jus-alpukat.jpg",
  "Jus Mangga": "/sample/menu/jus-mangga.jpg",
  "Soda Leci": "/sample/menu/soda-leci.jpg",

  // Dapur: rice plates, noodles, soups and the fried sides.
  "Nasi Goreng Kampung": "/sample/menu/nasi-goreng.jpg",
  "Nasi Goreng Ayam": "/sample/menu/nasi-goreng.jpg",
  "Mie Goreng Jawa": "/sample/menu/mie-goreng.jpg",
  "Mie Kuah": "/sample/menu/mie-kuah.jpg",
  "Ayam Sambal Matah": "/sample/menu/ayam-geprek.jpg",
  "Ayam Geprek": "/sample/menu/ayam-geprek.jpg",
  "Rice Bowl Teriyaki": "/sample/menu/rice-bowl.jpg",
  "Soto Ayam": "/sample/menu/soto-ayam.jpg",
  "Sup Buntut": "/sample/menu/sup-buntut.jpg",
  "Sate Ayam": "/sample/menu/sate-ayam.jpg",
  "Pasta Aglio Olio": "/sample/menu/aglio-olio.jpg",
  "Pasta Carbonara": "/sample/menu/carbonara.jpg",
  "Burger Sapi": "/sample/menu/burger.jpg",
  "Kentang Goreng": "/sample/menu/fries.jpg",
  "Salad Sayur": "/sample/menu/salad.jpg",

  // Pastry and sweets.
  "Croissant Mentega": "/sample/menu/croissant-mentega.jpg",
  "Croissant Cokelat": "/sample/menu/croissant-cokelat.jpg",
  "Roti Bakar Cokelat": "/sample/menu/roti-bakar.jpg",
  "Roti Bakar Keju": "/sample/menu/roti-bakar-keju.jpg",
  "Banana Bread": "/sample/menu/banana-bread.jpg",
  Brownies: "/sample/menu/brownies.jpg",
  Cheesecake: "/sample/menu/cheesecake.jpg",
  Tiramisu: "/sample/menu/tiramisu.jpg",
  "Donat Gula": "/sample/menu/donuts.jpg",
  "Donat Cokelat": "/sample/menu/donuts.jpg",
  "Muffin Pisang": "/sample/menu/muffin.jpg",
  "Muffin Cokelat": "/sample/menu/muffin.jpg",
  "Kue Wortel": "/sample/menu/carrot-cake.jpg",
  "Cookies Cokelat": "/sample/menu/cookies.jpg",
  "Pie Apel": "/sample/menu/apple-pie.jpg",

  // The combo reads as its own bundle photo (coffee + croissant).
  "Paket Kopi dan Croissant": "/sample/menu/combo.jpg",
};

/**
 * Photo name per stable sample reference, for screens whose own copy must not
 * carry a fixture item name (legend-n64n): the name lives only in this
 * mock/demo module, so a normal build ships none of it.
 */
export const demoPhotoRefs: Record<string, string> = {
  "nasi-goreng": "Nasi Goreng Kampung",
  "menu-nasi-goreng": "Nasi Goreng Kampung",
};

/** Demo photo for a fixture item name, or null when the demo has none. */
export function demoMenuPhoto(name: string): string | null {
  return demoPhotos[name] ?? null;
}

/**
 * Website demo hero: the cafe interior. The contract requires an https URL
 * (`PublicSite.heroImages`), so the website overlays this local sample in mock
 * mode instead of putting a relative path in the API payload.
 */
export function demoHeroPhoto(): string | null {
  return "/sample/menu/cafe-hero.jpg";
}

/** Website demo gallery in display order (interior, then the coffee glass). */
export function demoGalleryPhotos(): string[] {
  return ["/sample/menu/cafe-hero.jpg", "/sample/menu/es-kopi-susu.jpg"];
}
