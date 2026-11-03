// The guest booking page (PRD v1.7 §3.22 "Reservasi & Event", §4 Alur H): one
// screen with the date/time/pax/zone search, the guest details and the
// optional pre-order, and the confirmation that carries the policy snapshot
// (RSV-03) and the DP payment link (RSV-02). `?mode=antre` switches to the
// walk-in waitlist; the choice lives in the URL so both are deep-linkable.
//
// The confirmation is restored from sessionStorage (keyed by reservation id)
// after a reload, so a guest who refreshes does not lose the payment link.
import * as React from "react";
import type { ReservationCreated } from "@starter/shared/reservation";
import type { PublicSite } from "@starter/shared/website";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SiteSection } from "@/features/ws08-website/components/blocks";
import { SiteFrame } from "@/features/ws08-website/components/site-frame";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import { clearConfirmation, readConfirmation } from "../lib";
import { BookingPanel } from "./booking-panel";
import { ConfirmationPanel } from "./confirmation-panel";
import { WaitlistPanel } from "./waitlist-panel";

export type ReservationMode = "booking" | "antre";

export function ReservasiPage({
  site,
  signedIn,
  mode,
  onModeChange,
}: {
  site: PublicSite;
  signedIn: boolean;
  mode: ReservationMode;
  onModeChange: (mode: ReservationMode) => void;
}) {
  const t = useT();
  const [confirmation, setConfirmation] =
    React.useState<ReservationCreated | null>(null);

  // Storage is browser-only: restore after mount so the server render and the
  // first client render agree (no hydration mismatch).
  // Re-read when the guest returns to the booking tab: a booking that finished
  // while the waitlist tab was open was saved by the mutation itself.
  React.useEffect(() => {
    if (mode !== "booking") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage cannot be read during SSR; restoring after mount is the point.
    setConfirmation(readConfirmation());
  }, [mode]);

  const startOver = () => {
    clearConfirmation();
    setConfirmation(null);
  };

  // useCreateBooking already saved it to sessionStorage.
  const created = (next: ReservationCreated) => setConfirmation(next);

  return (
    <SiteFrame site={site} signedIn={signedIn}>
      <SiteSection innerClassName="pb-4 sm:pb-2">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display-xl">{t("reservationBooking.title")}</h1>
            {API_MOCK && <Badge>{t("common.sampleData")}</Badge>}
          </div>
          <p className="max-w-2xl text-lg leading-7 text-muted-foreground">
            {t("reservationBooking.lead")}
          </p>
        </div>
      </SiteSection>

      <SiteSection innerClassName="grid gap-6 pt-0">
        <SegmentedControl
          value={mode}
          onValueChange={onModeChange}
          label={t("reservationBooking.mode.label")}
          options={[
            {
              value: "booking" as const,
              label: t("reservationBooking.mode.booking"),
            },
            {
              value: "antre" as const,
              label: t("reservationBooking.mode.waitlist"),
            },
          ]}
        />
        {mode === "antre" ? (
          <WaitlistPanel
            site={site}
            onBooking={() => onModeChange("booking")}
          />
        ) : confirmation ? (
          <ConfirmationPanel
            site={site}
            created={confirmation}
            onNew={startOver}
          />
        ) : (
          <BookingPanel
            site={site}
            onCreated={created}
            onJoinWaitlist={() => onModeChange("antre")}
          />
        )}
      </SiteSection>
    </SiteFrame>
  );
}
