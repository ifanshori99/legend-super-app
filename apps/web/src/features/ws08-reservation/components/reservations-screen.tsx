// Reservation desk (PRD v1.7 §3 F19, §3.22 "Reservasi & Event"): the day
// schedule with table assignment, the walk-in waitlist and the event pre-order
// packages, one screen for the host stand. The ops area already supplies the
// shell, density and guard; this component owns the tabs and the detail sheet.
import { useT } from "@/components/i18n";
import { EmptyState } from "@/components/ui/feedback-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTenantContext } from "@/lib/tenant-context";
import type { ReservationStatus } from "@starter/shared/reservation";
import { PackagesTab } from "./packages-tab";
import { RescheduleTab } from "./reschedule-tab";
import { ReservationDetailDialog } from "./reservation-detail";
import { ScheduleTab } from "./schedule-tab";
import { WaitlistTab } from "./waitlist-tab";

export type ReservationTab =
  "schedule" | "waitlist" | "reschedule" | "packages";

function ScreenHeader({ outletName }: { outletName?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="type-display">{t("reservation.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("reservation.subtitle")}
        </p>
      </div>
      {outletName && (
        <p className="text-sm font-semibold">
          {t("reservation.outletContext", { name: outletName })}
        </p>
      )}
    </div>
  );
}

type ReservationsScreenProps = {
  tab: ReservationTab;
  date: string | undefined;
  status: ReservationStatus | undefined;
  reservationId: string | undefined;
  onTabChange: (tab: ReservationTab) => void;
  onDateChange: (date: string | undefined) => void;
  onStatusChange: (status: ReservationStatus | undefined) => void;
  onOpenReservation: (reservationId: string) => void;
  /** `replace`: drop the id without a history entry (an id that is not this
   * outlet's), so Back does not return to it. */
  onCloseReservation: (options?: { replace?: boolean }) => void;
};

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh desk, so a tab
 * state or open reservation of the previous outlet cannot leak into this one.
 */
export function ReservationsScreen(props: ReservationsScreenProps) {
  const { outlet } = useTenantContext();
  return <ReservationsContent key={outlet?.id ?? "none"} {...props} />;
}

function ReservationsContent({
  tab,
  date,
  status,
  reservationId,
  onTabChange,
  onDateChange,
  onStatusChange,
  onOpenReservation,
  onCloseReservation,
}: ReservationsScreenProps) {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();

  if (!outlet)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <ScreenHeader />
        <EmptyState
          title={t("reservation.errors.noOutletTitle")}
          description={t("reservation.errors.noOutletHint")}
        />
      </div>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ScreenHeader outletName={outlet.name} />

      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as ReservationTab)}
      >
        <TabsList aria-label={t("reservation.tabs.label")}>
          <TabsTrigger value="schedule">
            {t("reservation.tabs.schedule")}
          </TabsTrigger>
          <TabsTrigger value="waitlist">
            {t("reservation.tabs.waitlist")}
          </TabsTrigger>
          <TabsTrigger value="reschedule">
            {t("reservation.tabs.reschedule")}
          </TabsTrigger>
          <TabsTrigger value="packages">
            {t("reservation.tabs.packages")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schedule" className="mt-4">
          <ScheduleTab
            outletId={outlet.id}
            timeZone={outlet.timeZone}
            date={date}
            status={status}
            selectedId={reservationId}
            onDateChange={onDateChange}
            onStatusChange={onStatusChange}
            onOpen={onOpenReservation}
          />
        </TabsContent>
        <TabsContent value="waitlist" className="mt-4">
          <WaitlistTab outletId={outlet.id} timeZone={outlet.timeZone} />
        </TabsContent>
        <TabsContent value="reschedule" className="mt-4">
          <RescheduleTab
            outletId={outlet.id}
            timeZone={outlet.timeZone}
            onOpenReservation={onOpenReservation}
          />
        </TabsContent>
        <TabsContent value="packages" className="mt-4">
          <PackagesTab outletId={outlet.id} />
        </TabsContent>
      </Tabs>

      <ReservationDetailDialog
        open={reservationId !== undefined}
        onOpenChange={(open) => !open && onCloseReservation()}
        onNotFound={() => onCloseReservation({ replace: true })}
        outletId={outlet.id}
        timeZone={outlet.timeZone}
        reservationId={reservationId ?? null}
      />
    </div>
  );
}
