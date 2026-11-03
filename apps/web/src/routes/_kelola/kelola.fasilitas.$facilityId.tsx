import { createFileRoute } from "@tanstack/react-router";
import { FacilityConfigPage } from "@/features/facility-admin/components/facility-config-page";
import { facilityAdminGuard } from "@/features/facility-admin/guard";
import { isMockScenarioRequest } from "@/features/facility-admin/lib";
import { facilityConfigQuery } from "@/features/facility-admin/queries";

// /kelola/fasilitas/$facilityId — one facility's configuration editor (bead
// legend-er32; PRD v1.7 §3 F25). The id comes from the list contract; the API
// authorizes every write against the caller's outlet scope.
export const Route = createFileRoute("/_kelola/kelola/fasilitas/$facilityId")({
  beforeLoad: facilityAdminGuard,
  loader: ({ context, location, params }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : // prefetchQuery does not throw: a 404 renders the page's own "not
        // found" state (with a way back) instead of the router's error page.
        context.queryClient.prefetchQuery(
          facilityConfigQuery(params.facilityId),
        ),
  component: FacilityConfigScreen,
});

function FacilityConfigScreen() {
  const { facilityId } = Route.useParams();
  return <FacilityConfigPage facilityId={facilityId} />;
}
