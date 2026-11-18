import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { TicketIssueStep } from "@/features/ws04-pos-kasir/components/ticket/ticket-issue-step";
import { TicketSaleScreen } from "@/features/ws04-pos-kasir/components/ticket/ticket-sale-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/tiket — the cashier sells a facility ticket (shower, WFC day pass) to a
// customer; the sale opens a bill to pay (PRD §3 F22 "Penjualan Fasilitas",
// FAC-03). `?order&tiket` opens one paid ticket to issue its QR and PIN. The
// credential never rides in the URL. Presentation guard only; the API
// re-checks the sale on every request.
export const Route = createFileRoute("/_ops/pos/tiket")({
  validateSearch: z.object({
    order: z.string().min(1).optional().catch(undefined),
    tiket: z.string().min(1).optional().catch(undefined),
  }),
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["pos.sale.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: TicketRoute,
});

function TicketRoute() {
  const { order, tiket } = Route.useSearch();
  return order && tiket ? (
    <TicketIssueStep
      key={`${order}:${tiket}`}
      orderId={order}
      ticketId={tiket}
    />
  ) : (
    <TicketSaleScreen />
  );
}
