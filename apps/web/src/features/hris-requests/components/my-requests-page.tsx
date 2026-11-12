// "Pengajuan saya" — the employee's own swap, cover, leave and overtime
// requests with their status (bead legend-ydf2, mobile mockups kosong,
// ditolak). Data comes only from the hris-requests hooks; the screen shows
// loading, error (with the offline wording when the device is offline), empty
// and the list, and a notice when a supervisor rejected something.
import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, Plus } from "lucide-react";
import { useMemo } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";
import {
  useLeaveTypes,
  useMyLeaveRequests,
  useMyOvertimeRequests,
  useMyShiftAssignments,
  useMyShiftSwaps,
} from "../hooks.ts";
import { MyRequestCard } from "./my-requests-card.tsx";
import { buildMyRequests, countRejected } from "./my-requests-model.ts";

export function MyRequestsPage() {
  const t = useT();
  const online = useOnline();
  const swaps = useMyShiftSwaps();
  const leaves = useMyLeaveRequests();
  const overtimes = useMyOvertimeRequests();
  // Names and shift dates only decorate cards; a failure there never blocks the list.
  const leaveTypes = useLeaveTypes();
  const assignments = useMyShiftAssignments();

  const items = useMemo(
    () =>
      buildMyRequests({
        swaps: swaps.data,
        leaves: leaves.data,
        overtimes: overtimes.data,
        leaveTypeNames: new Map(
          (leaveTypes.data ?? []).map((type) => [type.id, type.name]),
        ),
        assignmentDates: new Map(
          (assignments.data ?? []).map((a) => [a.id, a.businessDate]),
        ),
      }),
    [
      swaps.data,
      leaves.data,
      overtimes.data,
      leaveTypes.data,
      assignments.data,
    ],
  );

  const lists = [swaps, leaves, overtimes];
  const isPending = lists.some((query) => query.isPending);
  const failed = lists.find((query) => query.isError);
  const refetching = lists.some((query) => query.isRefetching);
  const rejected = countRejected(items);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("hrisRequestsMine.list.back")}
          </Link>
        </Button>
        <header className="grid gap-1">
          <h1 className="font-brand type-display-xl">
            {t("hrisRequestsMine.list.title")}
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hrisRequestsMine.list.subtitle")}
          </p>
        </header>
      </div>

      {isPending ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only" role="status">
            {t("hrisRequestsMine.list.loading")}
          </span>
          <Skeleton className="h-36 w-full rounded-container" />
          <Skeleton className="h-36 w-full rounded-container" />
        </div>
      ) : failed ? (
        <ErrorState
          error={failed.error}
          title={t("hrisRequestsMine.list.error.title")}
          description={
            online
              ? t("hrisRequestsMine.list.error.description")
              : t("hrisRequestsMine.list.error.offlineDescription")
          }
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={refetching}
              onClick={() => {
                for (const query of lists) void query.refetch();
              }}
            >
              {t("hrisRequestsMine.list.error.retry")}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={t("hrisRequestsMine.list.empty.title")}
          description={t("hrisRequestsMine.list.empty.description")}
          action={
            <Button asChild size="lg" className="w-full">
              <Link to="/karyawan/pengajuan/baru">
                <Plus aria-hidden="true" />
                {t("hrisRequestsMine.list.create")}
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          {rejected > 0 && (
            <div
              role="status"
              className="grid gap-0.5 rounded-container border-l-4 border-danger bg-danger-subtle px-4 py-3 text-sm leading-5"
            >
              <p className="font-bold">
                {t("hrisRequestsMine.list.rejected.title")}
              </p>
              <p>
                {t("hrisRequestsMine.list.rejected.body", { count: rejected })}
              </p>
            </div>
          )}
          <ul
            aria-label={t("hrisRequestsMine.list.listLabel")}
            className="grid gap-3"
          >
            {items.map((item) => (
              <li key={item.key}>
                <MyRequestCard item={item} />
              </li>
            ))}
          </ul>
          <Button asChild size="lg" className="w-full">
            <Link to="/karyawan/pengajuan/baru">
              <Plus aria-hidden="true" />
              {t("hrisRequestsMine.list.create")}
            </Link>
          </Button>
        </>
      )}

      <Button asChild variant="link" size="sm" className="w-fit">
        <Link to="/karyawan/libur">
          <CalendarDays aria-hidden="true" />
          {t("hrisRequestsMine.list.holidayLink")}
        </Link>
      </Button>
    </div>
  );
}
