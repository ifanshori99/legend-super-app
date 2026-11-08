import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { BlindCountScreen } from "@/features/ws04-pos-kasir/components/shift/blind-count-screen";
import { cashierShiftGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/shift/tutup — close shift, step 1: the cashier counts the drawer per
// denomination without seeing the system balance (blind count).
// `?recount=<sequence>` opens the form to replace that sent count.
const searchSchema = z.object({
  recount: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/pos/shift/tutup")({
  validateSearch: searchSchema,
  beforeLoad: cashierShiftGuard(),
  component: TutupShiftRoute,
});

function TutupShiftRoute() {
  const { recount } = Route.useSearch();
  return <BlindCountScreen recountFrom={recount} />;
}
