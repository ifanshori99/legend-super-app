import { Link } from "@tanstack/react-router";
import { Ticket } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useOrderTickets } from "../../ticket/hooks";

// A paid bill that carried facility tickets: one small card per ticket that is
// ready to issue. The list comes from the server; the link carries only the
// order and ticket ids, never the credential. Quiet while loading, on error,
// or when the bill has no ticket.
export function PaidTicketCard({ orderId }: { orderId: string }) {
  const t = useT();
  const tickets = useOrderTickets(orderId);
  const ready = (tickets.data ?? []).filter(
    (line) => line.lineStatus === "issued",
  );
  if (ready.length === 0) return null;

  return (
    <div data-slot="paid-ticket-card" className="grid w-full max-w-2xl gap-3">
      {ready.map((line) => (
        <div
          key={line.ticketId}
          className="flex flex-wrap items-center justify-between gap-3 rounded-container border-(length:--border-w) border-border bg-card p-4 text-left"
        >
          <div className="grid gap-1">
            <p className="font-semibold">{t("posKasirTicket.paid.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("posKasirTicket.paid.hint", {
                name:
                  line.productName || t("posKasirTicket.issued.fallbackName"),
              })}
            </p>
          </div>
          <Button asChild>
            <Link
              to="/pos/tiket"
              search={{ order: orderId, tiket: line.ticketId }}
            >
              <Ticket aria-hidden="true" />
              {t("posKasirTicket.paid.link")}
            </Link>
          </Button>
        </div>
      ))}
    </div>
  );
}
