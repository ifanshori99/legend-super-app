import { Link } from "@tanstack/react-router";
import { Ticket } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrderTickets } from "../../ticket/hooks";
import { TicketError } from "../ticket/ticket-error";

// A paid bill that carried facility tickets: one small card per ticket that is
// ready to issue. The list comes from the server; the link carries only the
// order and ticket ids, never the credential. A skeleton holds the card's
// height while loading, a failed load says so with a retry, and the card is
// absent only when the bill has no ticket to issue.
export function PaidTicketCard({ orderId }: { orderId: string }) {
  const t = useT();
  const tickets = useOrderTickets(orderId);
  const ready = (tickets.data ?? []).filter(
    (line) => line.lineStatus === "issued",
  );
  if (tickets.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        data-slot="paid-ticket-card"
        className="w-full max-w-2xl"
      >
        <span className="sr-only">{t("posKasirTicket.step.loading")}</span>
        <Skeleton className="h-24 w-full rounded-container" />
      </div>
    );
  }
  if (tickets.isError) {
    return (
      <div data-slot="paid-ticket-card" className="w-full max-w-2xl text-left">
        <TicketError
          error={tickets.error}
          title={t("posKasirTicket.step.errorTitle")}
          onRetry={() => void tickets.refetch()}
        />
      </div>
    );
  }
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
