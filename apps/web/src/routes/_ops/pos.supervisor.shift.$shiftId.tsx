import { createFileRoute } from "@tanstack/react-router";
import { ShiftApprovalScreen } from "@/features/ws04-pos-kasir/components/supervisor/shift-approval-screen";
import { shiftApprovalGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/supervisor/shift/$shiftId — the supervisor reviews the cashier's count
// against the system figure and approves the close with an override.
export const Route = createFileRoute("/_ops/pos/supervisor/shift/$shiftId")({
  beforeLoad: shiftApprovalGuard(),
  component: ShiftApprovalRoute,
});

function ShiftApprovalRoute() {
  const { shiftId } = Route.useParams();
  return <ShiftApprovalScreen shiftId={shiftId} />;
}
