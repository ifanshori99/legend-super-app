import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { CorrectionScreen } from "@/features/ws04-pos-correction/components/correction-screen";
import {
  CORRECTION_MODES,
  type CorrectionMode,
} from "@/features/ws04-pos-correction/modes";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/pesanan/$orderId/koreksi — discount, void item, manual refund and the
// receipt preview of one order (PRD v1.7 §3 F11 POS-02/POS-04/POS-06, bead
// legend-2fo). `?mode=` picks the form ("Ajukan void item" on the order detail
// links here with `mode=void`, and `itemId` for the line); a bad value is
// dropped instead of failing the page.
const searchSchema = z.object({
  mode: z.enum(CORRECTION_MODES).optional().catch(undefined),
  itemId: z.string().min(1).max(64).optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/pos/pesanan/$orderId/koreksi")({
  validateSearch: searchSchema,
  // Presentation only; the API re-checks each request. Any of the actions on
  // this page is enough to open it, and each form asks for its own approval.
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: [
          "pos.discount.apply",
          "pos.void.request",
          "pos.refund.request",
          "pos.sale.create",
        ],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: CorrectionRoute,
});

function CorrectionRoute() {
  const { orderId } = Route.useParams();
  const { mode, itemId } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <CorrectionScreen
      orderId={orderId}
      mode={mode}
      itemId={itemId}
      onModeChange={(next: CorrectionMode) =>
        void navigate({
          to: "/pos/pesanan/$orderId/koreksi",
          params: { orderId },
          // Another mode starts without the line picked for the void.
          search: { mode: next },
          replace: true,
        })
      }
    />
  );
}
