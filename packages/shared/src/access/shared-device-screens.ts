// Which web screens a shared tablet (devices.shared_mode = true) may open
// (founder Q29, 18 Nov; bead legend-iq0jz). Allowlist, default closed: a new
// route is closed on a shared tablet until it is listed here.
//
// Presentation only. The API enforces the matching allowlist on every request
// (`SHARED_DEVICE_SCREEN_CLOSED`); this decides what the web app shows, so it
// hides the menu entries and answers "not found" instead of a screen whose
// requests would all be refused. Pure and browser-safe.

/**
 * Route prefixes open on a shared tablet, matched per path segment (`/pos`
 * opens `/pos` and `/pos/kasir`, never `/posx`).
 * - POS / cashier, including Reservasi (`/pos/reservasi`), tables, and the
 *   staff PIN switch (`/pos/ganti-pengguna`).
 * - Kitchen: KDS, Tanya AI in KDS (`/kds/tanya-ai`), `/kds/ganti-pengguna`,
 *   expo and pickup.
 * - Sign-in pages the tablet needs.
 */
const OPEN_PREFIXES: readonly string[] = [
  "/pos",
  "/kds",
  "/expo",
  "/pickup",
  "/sign-in",
  "/sign-up",
];

/**
 * Public pages that need no session (home, public menu, guest sign-in and
 * reservation, e-receipt). Matched like OPEN_PREFIXES; "/" matches only itself.
 */
const PUBLIC_PREFIXES: readonly string[] = [
  "/",
  "/menu",
  "/masuk",
  "/reservasi",
  "/reservation",
  "/r",
];

/** Encoded dot, slash and backslash: a path trick the router may decode later. */
const ENCODED_TRICK = /%(?:2e|2f|5c)/i;

function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return path === "/";
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True when a shared tablet may open this URL path. Query and hash are
 * ignored; case and a trailing slash do not matter. Anything unclear (`..`,
 * `//`, a backslash, an encoded dot or slash) is closed.
 */
export function isSharedDeviceScreenAllowed(pathname: string): boolean {
  const bare = pathname.split(/[?#]/, 1)[0] ?? "";
  if (!bare.startsWith("/")) return false;
  if (bare.includes("..") || bare.includes("//") || bare.includes("\\"))
    return false;
  if (ENCODED_TRICK.test(bare)) return false;
  const path = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  const lower = path.toLowerCase();
  return (
    OPEN_PREFIXES.some((prefix) => matchesPrefix(lower, prefix)) ||
    PUBLIC_PREFIXES.some((prefix) => matchesPrefix(lower, prefix))
  );
}
