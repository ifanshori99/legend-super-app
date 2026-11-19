import { createFileRoute, Outlet } from "@tanstack/react-router";
import { withI18nChunks } from "@/components/i18n";
import { AreaFrame } from "@/components/layout/area-frame";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "karyawan" (PRD §5). Guard and shell come from lib/areas/definitions.ts.
export const Route = createFileRoute("/_karyawan")({
  beforeLoad: ({ context }) =>
    withI18nChunks(
      ["karyawan"],
      runGuard(AREAS.karyawan.guard, context.access),
    ),
  head: () => ({
    ...areaHead("karyawan"),
    // HRIS is an installable PWA (PRD F30); the manifest is served per tenant.
    links: [{ rel: "manifest", href: "/manifest.webmanifest" }],
  }),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="karyawan" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
