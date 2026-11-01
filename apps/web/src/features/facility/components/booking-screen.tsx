// The customer booking journey at `/f/[facility]` — the facility QR entry
// (PRD §3 F22 Titik Masuk/Pemesanan, alur S langkah 1–4, alur T redemption).
// One route, four steps: WhatsApp gate → area and time → product/add-ons →
// review and pay. The ticket itself lives at `/member/fasilitas/[ticketId]`.
import { useCallback, useRef, useState } from "react";
import type {
  AccessTicket,
  AccessTicketCredential,
} from "@starter/shared/facility";
import type { BookTicketBody } from "../api";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  addDays,
  businessDateInOutletZone,
  draftPayableIdr,
  findArea,
  INITIAL_DRAFT,
  selectedAddons,
  unitsForSlot,
  type BookingDraft,
} from "../flow";
import {
  useAvailability,
  useBookTicket,
  useCurrentSubscription,
  useFacilityCatalog,
  useJoinQueue,
  useLeaveQueue,
  useQueueEntry,
} from "../hooks";
import { saveTicketCredential } from "../credential-store";
import { ExtrasStep } from "./extras-step";
import { IssuedStep } from "./issued-step";
import { LoginStep } from "./login-step";
import { ReviewStep } from "./review-step";
import { ScheduleStep } from "./schedule-step";
import { JourneyStepper, LoadingCard, type BookingStep } from "./shared";

type Phase = BookingStep | "issued";

export function FacilityBookingScreen({ facilityId }: { facilityId: string }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("login");
  const [dayOffset, setDayOffset] = useState<0 | 1>(0);
  const [draft, setDraft] = useState<BookingDraft>(INITIAL_DRAFT);
  const [issued, setIssued] = useState<{
    ticket: AccessTicket;
    credential: AccessTicketCredential;
  } | null>(null);

  const date = addDays(businessDateInOutletZone(new Date()), dayOffset);
  const availability = useAvailability(facilityId, date);
  const catalog = useFacilityCatalog(facilityId);
  const queue = useQueueEntry(facilityId);
  const subscription = useCurrentSubscription();
  const joinQueue = useJoinQueue(facilityId);
  const leaveQueue = useLeaveQueue(facilityId);
  const book = useBookTicket();
  // One idempotency key per booking attempt: a retry after a lost response
  // (timeout, offline) reuses it, so the API answers with the ticket it already
  // issued instead of selling a second one. Changing the draft starts a new
  // attempt.
  const attempt = useRef<{ draft: BookingDraft; key: string } | null>(null);
  const toSchedule = useCallback(() => setPhase("schedule"), []);

  const products =
    catalog.data?.products.filter(
      (product) => product.isActive && product.type !== "subscription_plan",
    ) ?? [];
  const addons = catalog.data?.addons.filter((addon) => addon.isEnabled) ?? [];
  const area = findArea(availability.data, draft.areaId);
  const product = products.find((item) => item.id === draft.productId);

  function idempotencyKeyFor(current: BookingDraft): string {
    if (attempt.current?.draft !== current)
      attempt.current = { draft: current, key: crypto.randomUUID() };
    return attempt.current.key;
  }

  async function pay() {
    if (!draft.areaId || !draft.timing || !draft.productId) return;
    const timing =
      draft.timing.kind === "now"
        ? ({ kind: "now" } as const)
        : ({ kind: "slot", startsAt: draft.timing.startsAt } as const);
    const unitId =
      timing.kind === "slot" && area
        ? unitsForSlot(area, timing.startsAt)[0]
        : undefined;
    const body: BookTicketBody = {
      facilityId,
      areaId: draft.areaId,
      unitId,
      timing,
      productId: draft.productId,
      source: draft.source,
      addonIds: draft.addonIds.length > 0 ? [...draft.addonIds] : undefined,
      idempotencyKey: idempotencyKeyFor(draft),
    };
    try {
      const result = await book.mutateAsync(body);
      // The credential is returned once: keep it for the ticket screen.
      saveTicketCredential(result.ticket.id, result.credential);
      attempt.current = null;
      setIssued(result);
      setPhase("issued");
    } catch {
      // Rendered by ReviewStep next to the pay button.
    }
  }

  return (
    <div className="grid gap-5 pb-4">
      <header className="grid gap-2">
        <div className="grid gap-1">
          <h1 className="text-2xl leading-8 font-semibold tracking-tight">
            {catalog.data?.facility.name ?? t("facility.entry.title")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("facility.entry.hint")}
          </p>
        </div>
        {phase !== "issued" && <JourneyStepper current={phase} />}
      </header>

      {phase === "login" && (
        <LoginStep returnTo={`/f/${facilityId}`} onVerified={toSchedule} />
      )}

      {phase === "schedule" && (
        <ScheduleStep
          availability={availability}
          dayOffset={dayOffset}
          onDayChange={(offset) => {
            setDayOffset(offset);
            // A slot belongs to one business date: pick again after switching.
            setDraft((current) =>
              current.timing?.kind === "slot"
                ? { ...current, timing: null }
                : current,
            );
          }}
          draft={draft}
          onDraftChange={setDraft}
          queueEntry={queue.data ?? null}
          onJoinQueue={(areaId) => joinQueue.mutate({ facilityId, areaId })}
          onLeaveQueue={(entryId) => leaveQueue.mutate(entryId)}
          queuePending={joinQueue.isPending || leaveQueue.isPending}
          queueError={joinQueue.error ?? leaveQueue.error ?? null}
          onContinue={() => setPhase("extras")}
        />
      )}

      {phase === "extras" &&
        (catalog.isPending ? (
          <LoadingCard lines={5} />
        ) : catalog.isError ? (
          <ErrorState onRetry={() => catalog.refetch()} />
        ) : (
          <>
            <ExtrasStep
              products={products}
              addons={addons}
              subscription={subscription.data ?? null}
              draft={draft}
              onDraftChange={setDraft}
              onContinue={() => setPhase("pay")}
            />
            <Button
              variant="ghost"
              onClick={() => setPhase("schedule")}
              className="justify-self-start"
            >
              {t("common.back")}
            </Button>
          </>
        ))}

      {phase === "pay" && area && product && (
        <ReviewStep
          draft={draft}
          areaName={area.name}
          product={product}
          addons={selectedAddons(draft, addons)}
          payableIdr={draftPayableIdr(draft, products, addons)}
          onBack={() => setPhase("extras")}
          onPay={() => void pay()}
          pending={book.isPending}
          error={book.error}
        />
      )}

      {phase === "issued" && issued && (
        <IssuedStep
          ticket={issued.ticket}
          credential={issued.credential}
          unitLabel={
            availability.data?.areas
              .flatMap((item) => item.units)
              .find((unit) => unit.unitId === issued.ticket.unitId)?.code ??
            null
          }
        />
      )}
    </div>
  );
}
