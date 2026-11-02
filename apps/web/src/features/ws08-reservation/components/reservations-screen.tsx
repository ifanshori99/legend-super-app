// Reservation desk (PRD v1.7 §3 F19, §3.22 "Reservasi & Event"): the day
// schedule with table assignment, the walk-in waitlist and the event pre-order
// packages, one screen for the host stand. The ops area already supplies the
// shell, density and guard; this component owns the tabs and the detail sheet.
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ReservationStatus } from "@starter/shared/reservation";
import { useOutlets } from "../hooks";
import { PackagesTab } from "./packages-tab";
import { ReservationDetailDialog } from "./reservation-detail";
import { ScheduleTab } from "./schedule-tab";
import { WaitlistTab } from "./waitlist-tab";

export type ReservationTab = "schedule" | "waitlist" | "packages";

function ScreenHeader({ outletName }: { outletName?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-bold">
          {t("reservation.title")}
        </h1>
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

export function ReservationsScreen({
  tab,
  date,
  status,
  reservationId,
  onTabChange,
  onDateChange,
  onStatusChange,
  onOpenReservation,
  onCloseReservation,
}: {
  tab: ReservationTab;
  date: string | undefined;
  status: ReservationStatus | undefined;
  reservationId: string | undefined;
  onTabChange: (tab: ReservationTab) => void;
  onDateChange: (date: string | undefined) => void;
  onStatusChange: (status: ReservationStatus | undefined) => void;
  onOpenReservation: (reservationId: string) => void;
  onCloseReservation: () => void;
}) {
  const t = useT();
  const outlets = useOutlets();
  const outlet =
    outlets.data?.data.find((row) => row.status === "active") ??
    outlets.data?.data[0];

  if (outlets.isPending)
    return (
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-10 w-96 max-w-full" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );

  if (outlets.error)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <ScreenHeader />
        <ErrorState
          title={t("reservation.list.errorTitle")}
          description={t("reservation.list.errorHint")}
          onRetry={() => void outlets.refetch()}
        />
      </div>
    );

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
            onDateChange={onDateChange}
            onStatusChange={onStatusChange}
            onOpen={onOpenReservation}
          />
        </TabsContent>
        <TabsContent value="waitlist" className="mt-4">
          <WaitlistTab outletId={outlet.id} timeZone={outlet.timeZone} />
        </TabsContent>
        <TabsContent value="packages" className="mt-4">
          <PackagesTab outletId={outlet.id} />
        </TabsContent>
      </Tabs>

      <ReservationDetailDialog
        open={reservationId !== undefined}
        onOpenChange={(open) => !open && onCloseReservation()}
        outletId={outlet.id}
        timeZone={outlet.timeZone}
        reservationId={reservationId ?? null}
      />
    </div>
  );
}
