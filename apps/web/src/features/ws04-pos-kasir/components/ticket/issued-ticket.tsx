import { Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { AccessTicketQr } from "../../../facility/components/access-ticket-qr";
import { formatClock, formatDateLabel } from "../../../facility/flow";
import type { OrderTicketLine, TicketCredential } from "../../ticket/types";
import { PosPanel, StateBlock, StatusPill } from "../shared";

// The credential was issued: show it at once (the guest is often waiting at the
// counter). "Cetak tiket" issues again with a new key: the server rotates the
// QR and PIN, prints the new ones, and the old ones stop working. The credential
// arrives as a prop from the parent's state and is never stored anywhere else.
// A failed reissue is not shown here: the parent drops the code and goes back to
// the issue step, because the server may already have rotated it.
export function IssuedTicket({
  line,
  credential,
  rotated,
  reissuing,
  onReissue,
}: {
  line: OrderTicketLine;
  credential: TicketCredential;
  /** True once the code was replaced by a second issue on this screen. */
  rotated: boolean;
  reissuing: boolean;
  onReissue: () => void;
}) {
  const t = useT();
  const name = line.productName || t("posKasirTicket.issued.fallbackName");
  const { print } = credential;

  const schedule =
    line.startsAt && line.endsAt
      ? t("posKasirTicket.issued.schedule", {
          date: formatDateLabel(line.startsAt),
          from: formatClock(line.startsAt),
          until: formatClock(line.endsAt),
        })
      : null;
  const place = !line.areaName
    ? null
    : line.unitCode
      ? t("posKasirTicket.issued.unit", {
          area: line.areaName,
          unit: line.unitCode,
        })
      : t("posKasirTicket.issued.areaOnly", { area: line.areaName });

  const printStatus = reissuing
    ? null
    : print.printedAt
      ? t(
          print.reprint
            ? "posKasirTicket.issued.reprinted"
            : "posKasirTicket.issued.printed",
          { printer: print.printerName ?? "" },
        )
      : t("posKasirTicket.issued.printNotAvailable");

  return (
    <div data-slot="issued-ticket" className="h-full">
      <PosPanel
        title={t("posKasirTicket.issued.title")}
        aside={
          <StatusPill tone="success">
            {t("posKasirTicket.issued.pill")}
          </StatusPill>
        }
        footer={
          <div className="grid w-full gap-2 sm:w-auto sm:justify-items-end">
            <p
              data-slot="ticket-print-hint"
              className="text-sm text-muted-foreground"
            >
              {t("posKasirTicket.issued.printHint")}
            </p>
            <div className="flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <Link to="/pos/tiket">
                  {t("posKasirTicket.issued.sellAnother")}
                </Link>
              </Button>
              <Button
                type="button"
                className="w-full sm:w-auto"
                disabled={reissuing}
                aria-busy={reissuing}
                onClick={onReissue}
              >
                <Printer aria-hidden="true" />
                {reissuing
                  ? t("posKasirTicket.issued.printing")
                  : t("posKasirTicket.issued.print")}
              </Button>
            </div>
          </div>
        }
      >
        <StateBlock
          mark="ok"
          title={name}
          description={t("posKasirTicket.issued.hint")}
        >
          <div className="grid w-full max-w-2xl gap-4 rounded-container bg-surface-3 p-4 text-left sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            <div data-slot="ticket-qr" className="justify-self-center">
              <AccessTicketQr
                value={credential.qrToken}
                label={t("posKasirTicket.issued.qrLabel", { product: name })}
              />
            </div>
            <div className="grid gap-1">
              {line.customerName ? (
                <p className="font-semibold">
                  {t("posKasirTicket.issued.customer", {
                    name: line.customerName,
                  })}
                </p>
              ) : null}
              {schedule ? (
                <p className="text-sm text-muted-foreground">{schedule}</p>
              ) : null}
              {place ? (
                <p className="text-sm text-muted-foreground">{place}</p>
              ) : null}
              <p className="type-eyebrow mt-2 text-muted-foreground">
                {t("posKasirTicket.issued.pinLabel")}
              </p>
              <p
                data-slot="ticket-pin"
                className="font-mono text-2xl leading-8 font-semibold tracking-[0.3em] tabular"
              >
                {credential.pin}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("posKasirTicket.issued.window", {
                  from: formatClock(credential.validFrom),
                  until: formatClock(credential.validUntil),
                })}
              </p>
              <Money amount={line.priceIdr} className="mt-1 font-bold" />
            </div>
          </div>
          {/* Always in the DOM so a screen reader announces the text that arrives. */}
          <p
            data-slot="ticket-rotated-note"
            role="status"
            className="min-h-5 text-sm font-semibold"
          >
            {rotated && !reissuing ? t("posKasirTicket.issued.rotated") : null}
          </p>
          <p
            data-slot="ticket-print-status"
            role="status"
            className="min-h-5 text-sm text-muted-foreground"
          >
            {printStatus}
          </p>
        </StateBlock>
      </PosPanel>
    </div>
  );
}
