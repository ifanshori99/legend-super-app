import { createFileRoute } from "@tanstack/react-router";
import { KpiPage } from "@/features/ws10-learning/components/kpi-page";
import { learningGuard } from "@/features/ws10-learning/guard";
import { isMockScenarioRequest } from "@/features/ws10-learning/lib";
import {
  employeesQuery,
  kpiReviewsQuery,
  positionsQuery,
} from "@/features/ws10-learning/queries";

// /kelola/kpi — KPI reviews per cycle and period (PRD v1.7 §3 F32 "Kinerja").
export const Route = createFileRoute("/_kelola/kelola/kpi/")({
  beforeLoad: learningGuard(["hr.kpi.manage"]),
  loader: ({ context, location }) => {
    // `?mock=empty|slow|…` must reach the browser, not be frozen into the SSR
    // HTML (docs/frontend.md "See loading, empty and error states").
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(kpiReviewsQuery()),
      context.queryClient.ensureQueryData(employeesQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
    ]);
  },
  component: KpiScreen,
});

function KpiScreen() {
  return <KpiPage />;
}
