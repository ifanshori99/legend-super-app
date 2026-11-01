import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AreaFrame } from "@/components/layout/area-frame";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "kelola" (PRD §5). Guard and shell come from lib/areas/definitions.ts.
export const Route = createFileRoute("/_kelola")({
  beforeLoad: ({ context }) => runGuard(AREAS.kelola.guard, context.access),
  head: () => areaHead("kelola"),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="kelola" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
