import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { AccessTicketQr } from "../../../facility/components/access-ticket-qr";
import { formatClock, formatDateLabel } from "../../../facility/flow";
import { usePrintTicket } from "../../ticket/hooks";
import type { SoldTicket } from "../../ticket/types";
import { TicketError } from "./ticket-error";
import { PosPanel, StateBlock, StatusPill } from "../shared";

// The sale went through: show the ticket at once (the guest is often waiting at
// the counter), then print it through the Print Agent. A print failure never
// voids the ticket; the QR and PIN stay on screen.
export function IssuedTicket({
  ticket,
  onSellAnother,
}: {
  ticket: SoldTicket;
  onSellAnother: () => void;
}) {
  const t = useT();
  const print = usePrintTicket();
  const printed = print.data;

  const schedule = t("posKasirTicket.issued.schedule", {
    date: formatDateLabel(ticket.startsAt),
    from: formatClock(ticket.startsAt),
    until: formatClock(ticket.endsAt),
  });
  const place = ticket.unitCode
    ? t("posKasirTicket.issued.unit", {
        area: ticket.areaName,
        unit: ticket.unitCode,
      })
    : t("posKasirTicket.issued.areaOnly", { area: ticket.areaName });

  const runPrint = () => {
    if (print.isPending) return;
    print.mutate({ ticketId: ticket.ticketId });
  };

  return (
    <PosPanel
      title={t("posKasirTicket.issued.title")}
      aside={
        <StatusPill tone="success">
          {t("posKasirTicket.issued.pill")}
        </StatusPill>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={onSellAnother}
          >
            {t("posKasirTicket.issued.sellAnother")}
          </Button>
          <Button
            type="button"
            className="w-full sm:w-auto"
            disabled={print.isPending}
            aria-busy={print.isPending}
            onClick={runPrint}
          >
            <Printer aria-hidden="true" />
            {print.isPending
              ? t("posKasirTicket.issued.printing")
              : printed
                ? t("posKasirTicket.issued.reprint")
                : t("posKasirTicket.issued.print")}
          </Button>
        </div>
      }
    >
      <StateBlock
        mark="ok"
        title={ticket.productName}
        description={t("posKasirTicket.issued.hint")}
      >
        <div className="grid w-full max-w-2xl gap-4 rounded-container bg-surface-3 p-4 text-left sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <AccessTicketQr
            value={ticket.qrToken}
            label={t("posKasirTicket.issued.qrLabel", {
              product: ticket.productName,
            })}
            className="justify-self-center"
          />
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("posKasirTicket.issued.customer", {
                name: ticket.customerName,
              })}
            </p>
            <p className="text-sm text-muted-foreground">{schedule}</p>
            <p className="text-sm text-muted-foreground">{place}</p>
            <p className="type-eyebrow mt-2 text-muted-foreground">
              {t("posKasirTicket.issued.pinLabel")}
            </p>
            <p className="font-mono text-2xl leading-8 font-semibold tracking-[0.3em] tabular">
              {ticket.pin}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("posKasirTicket.issued.window", {
                from: formatClock(ticket.validFrom),
                until: formatClock(ticket.validUntil),
              })}
            </p>
            <Money amount={ticket.priceIdr} className="mt-1 font-bold" />
          </div>
        </div>
        {/* Always in the DOM so a screen reader announces the text that arrives. */}
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {printed
            ? t(
                printed.reprint
                  ? "posKasirTicket.issued.reprinted"
                  : "posKasirTicket.issued.printed",
                { printer: printed.printerName },
              )
            : null}
        </p>
        {print.isError && (
          <div className="grid w-full max-w-2xl text-left">
            <TicketError
              error={print.error}
              title={t("posKasirTicket.issued.printFailedTitle")}
              hint={t("posKasirTicket.issued.printFailedHint")}
            />
          </div>
        )}
      </StateBlock>
    </PosPanel>
  );
}
