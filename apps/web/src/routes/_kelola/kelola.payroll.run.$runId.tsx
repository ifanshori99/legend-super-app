import { notFound, createFileRoute } from "@tanstack/react-router";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import { RunDetailPage } from "@/features/ws10-payroll-run/components/run-detail-page";
import { payrollRunGuard } from "@/features/ws10-payroll-run/guard";
import { isMockScenarioRequest } from "@/features/ws10-payroll-run/lib";
import { runQuery } from "@/features/ws10-payroll-run/queries";

// /kelola/payroll/run/$runId — one payroll run's wizard (PRD v1.7 §4 Alur K).
export const Route = createFileRoute("/_kelola/kelola/payroll/run/$runId")({
  beforeLoad: payrollRunGuard,
  loader: ({ context, location, params }) => {
    const runId = payrollRunIdSchema.safeParse(params.runId);
    if (!runId.success) throw notFound();
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return context.queryClient.ensureQueryData(runQuery(runId.data));
  },
  component: PayrollRunRoute,
});

function PayrollRunRoute() {
  const { access } = Route.useRouteContext();
  const { runId } = Route.useParams();
  return <RunDetailPage runId={runId} access={access} />;
}
