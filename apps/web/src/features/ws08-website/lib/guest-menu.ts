// Q23 (legend-qf0i): the public online menu never shows an item a guest
// cannot see a photo for. The API drops those rows in SQL before building the
// payload; this helper is the same rule for the mock/read-model side, where the
// photo is a resolved URL instead of `menu_items.media_id`.
//
// `photoOf` is the caller's photo source: the payload's own `imageUrl`, plus
// the sample overlay while the demo runs on fixtures (owner Q17/Q24).
import type {
  PublicMenuPage,
  PublicMenuItem,
  PublicMenuSection,
} from "@starter/shared/website";

export function withGuestPhotos(
  page: PublicMenuPage,
  photoOf: (item: PublicMenuItem) => string | null,
): PublicMenuPage {
  return {
    ...page,
    sections: page.sections.map((section): PublicMenuSection => ({
      ...section,
      items: section.items.filter((item) => photoOf(item) !== null),
    })),
  };
}
