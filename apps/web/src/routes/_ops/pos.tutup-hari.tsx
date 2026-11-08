import { createFileRoute } from "@tanstack/react-router";
import { DayCloseScreen } from "@/features/ws04-pos-kasir/components/day-close/day-close-screen";
import { shiftApprovalGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/tutup-hari — the outlet manager closes the business day (cut-off 04:00):
// recap, settlement per bank, accounting queue (PRD §3 F8 "Tutup Hari").
export const Route = createFileRoute("/_ops/pos/tutup-hari")({
  beforeLoad: shiftApprovalGuard(),
  component: DayCloseScreen,
});
