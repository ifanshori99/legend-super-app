import { createFileRoute, Outlet } from "@tanstack/react-router";
import { withI18nChunks } from "@/components/i18n";
import { AreaFrame } from "@/components/layout/area-frame";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "shareholder" (PRD §5). Guard and shell come from lib/areas/definitions.ts.
export const Route = createFileRoute("/_shareholder")({
  beforeLoad: ({ context }) =>
    withI18nChunks(
      ["shareholder"],
      runGuard(AREAS.shareholder.guard, context.access),
    ),
  head: () => areaHead("shareholder"),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="shareholder" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
