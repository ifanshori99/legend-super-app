// Access ticket screen (PRD §3 F22 "Tiket Akses"/"Sesi & Pengingat", alur S
// langkah 5–7). Shows the door QR and PIN, the session timer with the
// 5-minute reminder, the offline note (FAC-01/FAC-03: the lock verifies the
// credential locally) and the cancellation entry point.
import { useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { Ticket, WifiOff } from "lucide-react";
import type {
  AccessTicketView,
  FacilityAvailability,
} from "@starter/shared/facility";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { useCancelTicket } from "../hooks";
import {
  formatClock,
  formatDateLabel,
  ticketShowsCredential,
  ticketShowsTimer,
  unitLabel,
} from "../flow";
import {
  clearTicketCredential,
  readTicketCredential,
  subscribeTicketCredentials,
} from "../credential-store";
import { AccessTicketQr } from "./access-ticket-qr";
import { SessionTimer } from "./session-timer";
import { ApiFailure, LoadingCard, TicketStatusPill } from "./shared";

const subscribeNoop = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** False during SSR and hydration, true once the browser owns the page. */
function useHydrated() {
  return useSyncExternalStore(subscribeNoop, clientSnapshot, serverSnapshot);
}

/**
 * The credential is per-device (`credential-store.ts`): the store has no server
 * snapshot, so the server render and the first client render agree, and a
 * cleared browser shows the honest hint instead of a QR it does not have.
 */
function useStoredCredential(ticketId: string) {
  return useSyncExternalStore(
    subscribeTicketCredentials,
    () => readTicketCredential(ticketId),
    () => null,
  );
}

export function FacilityTicketScreen({
  view,
  availability,
}: {
  view: AccessTicketView;
  availability: FacilityAvailability | undefined;
}) {
  const t = useT();
  const online = useOnline();
  const toast = useToast();
  const ticket = view.ticket;
  const unit = unitLabel(availability, ticket.unitId);
  const storedCredential = useStoredCredential(ticket.id);
  // FAC-01: a ticket that can no longer open the door never shows its code.
  const credentialLive = ticketShowsCredential(ticket.status);
  const credential = credentialLive ? storedCredential : null;
  const hydrated = useHydrated();
  const cancel = useCancelTicket(ticket.id);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const cancellable =
    ticket.status === "issued" || ticket.status === "pending_payment";

  const schedule = t("facility.ticket.schedule", {
    date: formatDateLabel(ticket.slot.startsAt),
    from: formatClock(ticket.slot.startsAt),
    until: formatClock(ticket.slot.endsAt),
  });

  async function handleCancel() {
    try {
      const result = await cancel.mutateAsync(
        t("facility.ticket.cancelReason"),
      );
      setConfirmOpen(false);
      // The door credential is dead now; drop this device's copy.
      clearTicketCredential(ticket.id);
      toast({
        title: t("facility.ticket.cancelledToast"),
        description:
          result.feeIdr > 0
            ? t("facility.ticket.cancelledWithFee", {
                fee: formatRupiah(result.feeIdr),
              })
            : undefined,
        tone: "success",
      });
    } catch {
      // The error is rendered next to the dialog's action by ApiFailure.
    }
  }

  return (
    <div className="grid gap-5 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <Link
            to="/member/fasilitas"
            className="text-sm font-medium text-primary underline underline-offset-4"
          >
            {t("facility.ticket.backToList")}
          </Link>
          <h1 className="font-brand type-display-xl">
            {t("facility.ticket.title")}
          </h1>
        </div>
        <TicketStatusPill status={ticket.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-brand type-title tabular">
            {schedule}
          </CardTitle>
          <CardDescription className="tabular">
            {unit
              ? `${unit.areaName} · ${t("facility.ticket.unit")} ${unit.code}`
              : t("facility.entry.title")}
          </CardDescription>
        </CardHeader>
        {ticket.addons.length > 0 && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.review.addons")}:{" "}
            {ticket.addons.map((addon) => addon.name).join(", ")}
          </p>
        )}
      </Card>

      {credentialLive && (
        <Card>
          <CardHeader>
            <CardTitle className="font-brand type-title">
              {t("facility.ticket.credentialTitle")}
            </CardTitle>
            {credential && (
              <CardDescription>{t("facility.ticket.qrHint")}</CardDescription>
            )}
          </CardHeader>
          {!hydrated ? (
            <LoadingCard lines={4} />
          ) : credential === null ? (
            <div className="flex items-start gap-2 rounded-container bg-surface-2 px-3 py-2 text-sm leading-5">
              <Ticket className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="grid gap-0.5">
                <p className="type-heading">
                  {t("facility.ticket.credentialMissingTitle")}
                </p>
                <p className="text-muted-foreground">
                  {t("facility.ticket.credentialMissingBody")}
                </p>
                <p className="text-muted-foreground tabular">
                  {t("facility.ticket.window", {
                    from: formatClock(view.credentialWindow.validFrom),
                    until: formatClock(view.credentialWindow.validUntil),
                  })}
                </p>
              </div>
            </div>
          ) : credential ? (
            <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
              <AccessTicketQr
                value={credential.qrToken}
                label={t("facility.ticket.qrLabel", {
                  unit: unit?.code ?? "",
                })}
              />
              <div className="grid gap-1">
                <p className="type-eyebrow text-muted-foreground">
                  {t("facility.ticket.pinLabel")}
                </p>
                <p className="font-mono text-2xl leading-8 font-semibold tracking-[0.3em] tabular">
                  {credential.pin}
                </p>
                <p className="text-sm leading-5 text-muted-foreground tabular">
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
          ) : null}
        </Card>
      )}

      {ticketShowsTimer(ticket.status) && (
        <Card>
          <SessionTimer view={view} />
        </Card>
      )}

      {!online && (
        <Card>
          <div className="flex items-start gap-2">
            <WifiOff
              className="mt-0.5 size-5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div className="grid gap-0.5">
              <p className="type-heading">
                {t("facility.ticket.offlineTitle")}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("facility.ticket.offlineBody")}
              </p>
            </div>
          </div>
        </Card>
      )}

      {cancellable && (
        <div className="grid gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => setConfirmOpen(true)}
            disabled={cancel.isPending}
          >
            {t("facility.ticket.cancel")}
          </Button>
          {cancel.isError && <ApiFailure error={cancel.error} />}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("facility.ticket.cancelTitle")}</DialogTitle>
            <DialogDescription>
              {t("facility.ticket.cancelBody")}
            </DialogDescription>
          </DialogHeader>
          {cancel.isError && <ApiFailure error={cancel.error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("common.close")}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              loading={cancel.isPending}
              onClick={handleCancel}
            >
              {t("facility.ticket.cancelConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
