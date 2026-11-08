import { createFileRoute } from "@tanstack/react-router";
import { ShiftActiveScreen } from "@/features/ws04-pos-kasir/components/shift/shift-active-screen";
import { cashierShiftGuard } from "@/features/ws04-pos-kasir/guard";
import { shiftSearchSchema } from "@/features/ws04-pos-kasir/return-to";

// /pos/shift — the cashier's shift: open form when none, otherwise the active
// shift with its cash history (PRD §3 F8). The open/active switch lives in the
// shift screen (S2), which reads the active shift through its hook.
export const Route = createFileRoute("/_ops/pos/shift/")({
  validateSearch: shiftSearchSchema,
  beforeLoad: cashierShiftGuard(),
  component: ShiftRoute,
});

function ShiftRoute() {
  const { returnTo } = Route.useSearch();
  return <ShiftActiveScreen returnTo={returnTo} />;
}
