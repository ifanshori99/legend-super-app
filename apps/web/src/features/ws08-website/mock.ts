// Mock mode for the public website (VITE_API_MOCK=true): serves the website
// fixtures from @starter/shared/website, so the brand site works with no API.
//
// The `empty` scenario is the honest "content not filled in yet" state: no
// featured menu, no promos, no highlights, and reservation requests closed
// (PRD: every screen has an empty state). The runtime validates every response
// against the contract, so these copies cannot drift from the schemas.
import {
  cafeLegendWebsiteFixtures,
  getPublicMenuPage,
  getPublicSite,
} from "@starter/shared/website";
import type { PublicMenuPage, PublicSite } from "@starter/shared/website";
import { registerMock } from "@/lib/mock/registry";

const { site, menuPage } = cafeLegendWebsiteFixtures;

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

registerMock(getPublicSite, ({ scenario }) => ({
  data: scenario === "empty" ? emptySite : site,
}));

registerMock(getPublicMenuPage, ({ scenario }) => ({
  data: scenario === "empty" ? emptyMenuPage : menuPage,
}));
