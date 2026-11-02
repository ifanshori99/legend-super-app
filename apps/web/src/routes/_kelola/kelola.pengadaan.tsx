import { createFileRoute, notFound } from "@tanstack/react-router";
import { PurchasingPage } from "@/features/ws06-purchasing/components/purchasing-page";
import { evaluateGuard } from "@/lib/areas/guard";

export const Route = createFileRoute("/_kelola/kelola/pengadaan")({
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
  component: PurchasingPage,
});
