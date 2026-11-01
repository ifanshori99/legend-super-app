// Ticket issued (alur S langkah 4 → 5): the credential is in hand, so show it
// at once — the guest is often standing at the door. The full ticket screen
// adds the session timer and the cancellation policy.
import { Link } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import type {
  AccessTicketCredential,
  AccessTicket,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatClock, formatDateLabel } from "../flow";
import { AccessTicketQr } from "./access-ticket-qr";

export function IssuedStep({
  ticket,
  credential,
  unitLabel,
}: {
  ticket: AccessTicket;
  credential: AccessTicketCredential;
  unitLabel: string | null;
}) {
  const t = useT();
  return (
    <div className="grid gap-5">
      <div className="grid justify-items-start gap-2">
        <span className="grid size-12 place-items-center rounded-full bg-success-subtle text-success">
          <CircleCheck className="size-6" aria-hidden="true" />
        </span>
        <h2 className="text-2xl leading-8 font-semibold tracking-tight">
          {t("facility.issued.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.issued.hint")}
        </p>
      </div>

      <Card>
        <div className="grid gap-1">
          <p className="font-semibold">
            {t("facility.ticket.schedule", {
              date: formatDateLabel(ticket.slot.startsAt),
              from: formatClock(ticket.slot.startsAt),
              until: formatClock(ticket.slot.endsAt),
            })}
          </p>
          {unitLabel && (
            <p className="text-sm leading-5 text-muted-foreground">
              {unitLabel}
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <AccessTicketQr
            value={credential.qrToken}
            label={t("facility.ticket.qrLabel", { unit: unitLabel ?? "" })}
          />
          <div className="grid gap-1">
            <p className="text-sm leading-5 font-medium text-muted-foreground">
              {t("facility.ticket.pinLabel")}
            </p>
            <p className="text-3xl leading-tight font-semibold tracking-[0.35em] tabular">
              {credential.pin}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.ticket.window", {
                from: formatClock(credential.validFrom),
                until: formatClock(credential.validUntil),
              })}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.ticket.pinHint")}
            </p>
          </div>
        </div>
      </Card>

      <Button asChild size="lg">
        <Link to="/member/fasilitas/$ticketId" params={{ ticketId: ticket.id }}>
          {t("facility.issued.openTicket")}
        </Link>
      </Button>
      <Button asChild variant="outline">
        <Link to="/member/fasilitas">{t("facility.issued.toFacilities")}</Link>
      </Button>
    </div>
  );
}
