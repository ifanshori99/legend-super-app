import { createFileRoute } from "@tanstack/react-router";
import { RunListPage } from "@/features/ws10-payroll-run/components/run-list-page";
import { payrollRunGuard } from "@/features/ws10-payroll-run/guard";
import { isMockScenarioRequest } from "@/features/ws10-payroll-run/lib";
import { RUNS_QUERY, runsQuery } from "@/features/ws10-payroll-run/queries";

// /kelola/payroll/run — payroll runs by period (PRD v1.7 §3 D.30, §4 Alur K,
// PAYR-01). The shell owns the h1; the page renders its own h2 sections.
export const Route = createFileRoute("/_kelola/kelola/payroll/run/")({
  beforeLoad: payrollRunGuard,
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(runsQuery(RUNS_QUERY)),
  component: PayrollRunsRoute,
});

function PayrollRunsRoute() {
  const { access } = Route.useRouteContext();
  return <RunListPage access={access} />;
}
