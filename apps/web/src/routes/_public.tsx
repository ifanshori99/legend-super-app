import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { useT, withI18nChunks } from "@/components/i18n";
import { AreaGateScreen } from "@/components/layout/area-gate-screen";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { ThemeScope } from "@/components/theme-scope";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "public" (PRD §5): the brand website — SSR, CDN cache, indexed — plus
// the customer sign-in entry (/masuk). Guard and density still come from the
// area definition; the pages own their frame:
//
// - the brand site (/ , /menu, /reservation) renders the website's own wide,
//   photo-first frame (features/ws08-website/components/site-frame.tsx);
// - the sign-in screens keep a centered reading column.
//
// TEN-08: nothing here prints the platform name; brand text comes from the
// site payload, and the sign-in screens print their own copy.
export const Route = createFileRoute("/_public")({
  beforeLoad: ({ context }) =>
    withI18nChunks(["public"], runGuard(AREAS.public.guard, context.access)),
  head: () => areaHead("public"),
  component: Layout,
});

const WEBSITE_PATHS = new Set([
  "/",
  "/menu",
  "/reservation",
  // The guest booking form behind the reservation entry page (legend-xm4y).
  "/reservasi",
]);

// The public e-receipt (/r/:token) is a bare reading column: no site
// navigation, nothing that could leak the token to another page (legend-1uk9).
const RECEIPT_PREFIX = "/r/";

// The guest's manage-reservation page (/reservasi/kelola#token) is a bare
// column too, but not part of the brand site: it draws its own frame, with its
// own <main id="main-content">, and no site navigation (legend-g12il).
const GUEST_MANAGE_PATH = "/reservasi/kelola";

function Layout() {
  const { gate } = Route.useRouteContext();
  const { pathname } = useLocation();
  const t = useT();
  if (gate.status !== "allowed")
    return <AreaGateScreen area="public" gate={gate} />;
  return (
    <ThemeScope density="hangat" className="min-h-dvh bg-background">
      {WEBSITE_PATHS.has(pathname) ||
      pathname === GUEST_MANAGE_PATH ||
      pathname.startsWith(`${GUEST_MANAGE_PATH}/`) ? (
        <Outlet />
      ) : pathname.startsWith(RECEIPT_PREFIX) ? (
        <main
          id="main-content"
          className="mx-auto w-full max-w-2xl px-gutter py-6"
        >
          <Outlet />
        </main>
      ) : (
        <div className="mx-auto w-full max-w-2xl px-gutter py-6">
          <div className="mb-6 flex items-center justify-between">
            <Link
              to="/"
              className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              {t("website.nav.home")}
            </Link>
            <ThemeToggle />
          </div>
          {/* The skip link in __root targets #main-content; the brand site
              frame renders its own <main>. */}
          <main id="main-content">
            <Outlet />
          </main>
        </div>
      )}
    </ThemeScope>
  );
}
