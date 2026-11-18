import { createFileRoute, notFound } from "@tanstack/react-router";
import { TicketSaleScreen } from "@/features/ws04-pos-kasir/components/ticket/ticket-sale-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/tiket — the cashier sells a facility ticket (shower, WFC day pass) to a
// customer and prints it (PRD §3 F22 "Penjualan Fasilitas", FAC-03). Presentation
// guard only; the API re-checks the sale on every request.
export const Route = createFileRoute("/_ops/pos/tiket")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["pos.sale.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: TicketSaleScreen,
});
