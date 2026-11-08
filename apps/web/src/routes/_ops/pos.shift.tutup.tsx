import { createFileRoute } from "@tanstack/react-router";
import { BlindCountScreen } from "@/features/ws04-pos-kasir/components/shift/blind-count-screen";
import { cashierShiftGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/shift/tutup — close shift, step 1: the cashier counts the drawer per
// denomination without seeing the system balance (blind count).
export const Route = createFileRoute("/_ops/pos/shift/tutup")({
  beforeLoad: cashierShiftGuard(),
  component: BlindCountScreen,
});
