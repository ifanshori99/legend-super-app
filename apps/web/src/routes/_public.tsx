import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AreaGateScreen } from "@/components/layout/area-gate-screen";
import { ThemeScope } from "@/components/theme-scope";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "public" (PRD §5): the brand website — SSR, CDN cache, indexed. It
// renders the website's own frame (wide, warm, brand-first, see
// features/ws08-website/components/site-frame.tsx) instead of the customer app
// shell: a visitor on the brand domain should see the cafe, not app chrome.
// Guard and density still come from the area definition.
export const Route = createFileRoute("/_public")({
  beforeLoad: ({ context }) => runGuard(AREAS.public.guard, context.access),
  head: () => areaHead("public"),
  component: Layout,
});

function Layout() {
  const { gate } = Route.useRouteContext();
  if (gate.status !== "allowed")
    return <AreaGateScreen area="public" gate={gate} />;
  return (
    <ThemeScope density="hangat" className="min-h-dvh bg-background">
      <Outlet />
    </ThemeScope>
  );
}
