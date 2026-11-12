import { createFileRoute, notFound } from "@tanstack/react-router";
import { TablesScreen } from "@/features/ws04-pos-order/components/captain/tables-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/captain: pick a table to take an order for.
// Presentation guard only; the API re-checks every request.
export const Route = createFileRoute("/_ops/pos/captain/")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["order.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: TablesScreen,
});
