// Menu error codes (docs/plan/contracts.md D-CORE-4: a domain declares its own
// UPPER_SNAKE codes next to its schemas). One code means one thing across
// modules; the web app maps `code` to catalog text.
//
// These are raised by the menu services through the API's HttpError, whose
// status is the one declared here (the shared error handler already exposes
// HttpError codes verbatim). A page can also fail them client side before the
// request leaves the browser — the rule below is the single source of truth.

export const menuErrorHttpStatus = {
  /**
   * Owner decision Q23: every menu item must have a photo. An item can only be
   * active (published to QR order, POS and the other channels) with a photo
   * attached, so creating or activating one without `mediaId` is refused.
   */
  MENU_PHOTO_REQUIRED: 422,
} as const satisfies Record<string, number>;

export type MenuErrorCode = keyof typeof menuErrorHttpStatus;
export const MENU_ERROR_CODES = Object.keys(
  menuErrorHttpStatus,
) as MenuErrorCode[];

/** Safe Indonesian fallback; the UI maps `code` to catalog text. */
export const MENU_PHOTO_REQUIRED_MESSAGE =
  "Unggah foto item sebelum item dapat ditampilkan di menu.";

/**
 * Q23: is this item state missing its mandatory photo? `isActive` is the
 * published flag of the menu contract (PRD §8 "Konten Menu", owner Q17/Q23);
 * there is no separate publish switch.
 *
 * Existing rows without a photo stay readable and editable — they just can
 * never become active. Callers pass the state *after* the write they are about
 * to apply, so create, activate and "remove the photo of an active item" are
 * all covered by one rule.
 */
export function menuItemPhotoMissing(input: {
  isActive: boolean;
  mediaId?: string | null;
}): boolean {
  return input.isActive && (input.mediaId ?? null) === null;
}

/**
 * Q23 (legend-qf0i): may this row reach a guest? Rows created before the photo
 * rule can still be active without `media_id`; they stay in the back office
 * (listed with the "Foto wajib" badge, editable, deactivatable) but every
 * public read — QR order menu, POS item picker, public website menu — must
 * skip them instead of rendering a broken photo card.
 *
 * This is the row-level rule; the API mirrors it in SQL
 * (`guestMenuItemCondition`, apps/api/src/services/menu-internals.ts) so a
 * guest query cannot forget the photo half of `is_active`.
 */
export function menuItemVisibleToGuests(input: {
  isActive: boolean;
  mediaId?: string | null;
}): boolean {
  return input.isActive && (input.mediaId ?? null) !== null;
}
