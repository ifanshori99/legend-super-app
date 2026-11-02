import { createFileRoute, notFound } from "@tanstack/react-router";
import { PurchaseOrderPrintPage } from "@/features/ws06-purchasing/components/purchase-order-print-page";
import { evaluateGuard } from "@/lib/areas/guard";

export const Route = createFileRoute("/_kelola/kelola/pengadaan_/po/$id/cetak")(
  {
    beforeLoad: ({ context }) => {
      const gate = evaluateGuard(
        {
          kind: "permission",
          surface: "dashboard",
          anyOf: [
            "purchasing.request.create",
            "purchasing.order.create",
            "purchasing.order.approve",
          ],
        },
        context.access,
      );
      if (gate.status !== "allowed") throw notFound();
    },
    component: PrintPage,
  },
);

function PrintPage() {
  const { id } = Route.useParams();
  return <PurchaseOrderPrintPage id={id} />;
}
