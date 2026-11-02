// Mock mode for the public website (VITE_API_MOCK=true): serves the website
// fixtures from @starter/shared/website, so the brand site works with no API.
//
// The `empty` scenario is the honest "content not filled in yet" state: no
// featured menu, no promos, no highlights, and reservation requests closed
// (PRD: every screen has an empty state). The runtime validates every response
// against the contract, so these copies cannot drift from the schemas.
//
// Q23 (legend-qf0i): a guest read never carries an item without a photo. The
// API drops those rows in SQL (`guestMenuItemCondition`); the mock mirrors it
// on the item's photo — the fixture `imageUrl`, or the demo overlay that the
// sample catalogue supplies by name. The `photo-missing` scenario injects the
// legacy row before the filter, so the hidden case is observable.
import {
  cafeLegendWebsiteFixtures,
  getPublicMenuPage,
  getPublicSite,
} from "@starter/shared/website";
import type { PublicMenuItem, PublicMenuPage } from "@starter/shared/website";
import type { PublicSite } from "@starter/shared/website";
import {
  legacyPhotoMissingItem,
  legacyPhotoMissingPrice,
} from "@starter/shared/menu";
import { demoMenuPhoto } from "@/lib/demo-media.ts";
import { registerMock } from "@/lib/mock/registry";
import { withGuestPhotos } from "./lib/guest-menu.ts";

const { site, menuPage } = cafeLegendWebsiteFixtures;

/** The photo a guest would see: the payload URL or the demo overlay. */
const guestPhoto = (item: PublicMenuItem) =>
  item.imageUrl ?? demoMenuPhoto(item.name);

const emptySite: PublicSite = {
  ...site,
  highlights: [],
  featuredMenuItems: [],
  promotions: [],
  gallery: [],
  acceptsReservations: false,
};

const emptyMenuPage: PublicMenuPage = {
  ...menuPage,
  sections: menuPage.sections.map((section) => ({ ...section, items: [] })),
};

/** The legacy row, shaped like the fixture items of its section. */
const legacyMenuItem: PublicMenuItem = {
  id: legacyPhotoMissingItem.id,
  name: legacyPhotoMissingItem.name,
  description: legacyPhotoMissingItem.description,
  priceIdr: legacyPhotoMissingPrice.priceIdr,
  imageUrl: null,
  labels: legacyPhotoMissingItem.labels,
  allergens: legacyPhotoMissingItem.allergens,
  isAvailable: true,
};

registerMock(getPublicSite, ({ scenario }) => ({
  data: scenario === "empty" ? emptySite : site,
}));

registerMock(getPublicMenuPage, ({ scenario }) => {
  if (scenario === "empty") return { data: emptyMenuPage };
  const scenarioPage: PublicMenuPage =
    scenario === "photo-missing"
      ? {
          ...menuPage,
          sections: menuPage.sections.map((section, index) =>
            index === 0
              ? { ...section, items: [...section.items, legacyMenuItem] }
              : section,
          ),
        }
      : menuPage;
  return { data: withGuestPhotos(scenarioPage, guestPhoto) };
});
