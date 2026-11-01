import { createFileRoute } from "@tanstack/react-router";
import {
  AreaIndexPage,
  ReachableAreas,
} from "@/components/layout/area-index-page";

// "/" — brand home (PRD §5: SSR, CDN cache, indexed). Placeholder until the
// public brand website bead replaces it; staff see links to their work areas.
export const Route = createFileRoute("/_public/")({
  component: Home,
});

function Home() {
  const { access } = Route.useRouteContext();
  return (
    <>
      <AreaIndexPage area="public" />
      <ReachableAreas access={access} />
    </>
  );
}
