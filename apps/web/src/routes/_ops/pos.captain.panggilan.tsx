import { createFileRoute, notFound } from "@tanstack/react-router";
import { CallsScreen } from "@/features/ws04-pos-order/components/captain/calls-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/captain/panggilan: waiter calls for the captain's zone.
// Presentation guard only; the API re-checks every request.
export const Route = createFileRoute("/_ops/pos/captain/panggilan")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["order.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: CallsScreen,
});
