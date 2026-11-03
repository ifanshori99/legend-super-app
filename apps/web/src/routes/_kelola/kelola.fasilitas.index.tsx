import { createFileRoute } from "@tanstack/react-router";
import { FacilityListPage } from "@/features/facility-admin/components/facility-list-page";
import { facilityAdminGuard } from "@/features/facility-admin/guard";
import {
  isMockScenarioRequest,
  LIST_PAGE_LIMIT,
} from "@/features/facility-admin/lib";
import {
  facilitiesListQuery,
  facilityConfigQuery,
} from "@/features/facility-admin/queries";

// /kelola/fasilitas — facility configuration index (bead legend-er32; PRD v1.7
// §3 F25 "Model Generik"). The area layout already runs the kelola guard; this
// page additionally needs facility.config.manage.
export const Route = createFileRoute("/_kelola/kelola/fasilitas/")({
  beforeLoad: facilityAdminGuard,
  loader: async ({ context, location }) => {
    // `?mock=empty|slow|error|offline` must reach the browser, not be frozen
    // into the SSR HTML (docs/frontend.md "See loading, empty and error states").
    if (isMockScenarioRequest(location.searchStr)) return;
    const page = await context.queryClient.ensureQueryData(
      facilitiesListQuery({ limit: LIST_PAGE_LIMIT }),
    );
    // The list rows need their config for area/unit counts; prefetchQuery does
    // not throw, so one failing config still renders the list's error state
    // instead of the router's error page.
    await Promise.all(
      page.data.map((facility) =>
        context.queryClient.prefetchQuery(facilityConfigQuery(facility.id)),
      ),
    );
  },
  component: FacilityListPage,
});
