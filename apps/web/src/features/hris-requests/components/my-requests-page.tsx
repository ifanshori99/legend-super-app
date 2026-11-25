// "Pengajuan saya" — the employee's own swap, cover, leave and overtime
// requests with their status (bead legend-ydf2, mobile mockups kosong,
// ditolak). Data comes only from the hris-requests hooks; the screen shows
// loading, error (with the offline wording when the device is offline), empty
// and the list, and a notice when a supervisor rejected something.
import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";
import type { ShiftSwapRequest } from "@starter/shared/hris";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
  useMyHris,
  usePeerResponse,
} from "../hooks.ts";
import {
  hasSwapContext,
  hasShiftContext,
  requestShiftLabel,
} from "../request-context.ts";
import { useTenantContext } from "@/lib/tenant-context";
import { MyRequestCard } from "./my-requests-card.tsx";
import { buildMyRequests, countRejected } from "./my-requests-model.ts";

export function MyRequestsPage() {
  const t = useT();
  const online = useOnline();
  const swaps = useMyShiftSwaps();
  const me = useMyHris();
  const incoming = (swaps.data ?? []).filter(
    (swap) =>
      swap.toEmployeeId === me.data?.employee.id &&
      swap.status === "pending" &&
      swap.peerAcceptedAt === null,
  );
  const leaves = useMyLeaveRequests();
  const overtimes = useMyOvertimeRequests();
  // Names and shift dates only decorate cards; a failure there never blocks the list.
  const leaveTypes = useLeaveTypes();
  const assignments = useMyShiftAssignments();

  const items = buildMyRequests({
    swaps: swaps.data?.filter(
      (swap) => swap.requestedBy === me.data?.employee.id,
    ),
    leaves: leaves.data,
    overtimes: overtimes.data,
    leaveTypeNames: new Map(
      (leaveTypes.data ?? []).map((type) => [type.id, type.name]),
    ),
    assignmentDates: new Map(
      (assignments.data ?? []).map((a) => [a.id, a.businessDate]),
    ),
  });

  const lists = [swaps, leaves, overtimes];
  const isPending = me.isPending || lists.some((query) => query.isPending);
  const failed = me.isError ? me : lists.find((query) => query.isError);
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

      {incoming.map((swap) => (
        <PeerResponseCard key={swap.id} swap={swap} />
      ))}

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

      <Button
        asChild
        variant="link"
        size="sm"
        className="min-h-11 w-fit sm:min-h-0"
      >
        <Link to="/karyawan/libur">
          <CalendarDays aria-hidden="true" />
          {t("hrisRequestsMine.list.holidayLink")}
        </Link>
      </Button>
    </div>
  );
}

function PeerResponseCard({ swap }: { swap: ShiftSwapRequest }) {
  const t = useT();
  const response = usePeerResponse();
  const online = useOnline();
  const { outlet } = useTenantContext();
  const complete = hasSwapContext(swap);
  const blocked = !complete || !online || response.isPending;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Card className="grid gap-3">
      <h2 className="font-bold">{t("hrisRequestsMine.peerResponse.title")}</h2>
      <p className="text-sm">
        {t("hrisRequestsMine.peerResponse.descriptionPrefix")}
        {swap.toAssignmentId ? "tukar" : "ganti"}{" "}
        {t("hrisRequestsMine.peerResponse.descriptionSuffix")}
      </p>
      {complete ? (
        <div className="grid gap-1 text-sm text-muted-foreground">
          <p>
            {swap.requestedByName} → {swap.toEmployeeName}
          </p>
          {[
            swap.fromAssignment,
            swap.toAssignmentId === null ? null : swap.toAssignment,
          ]
            .filter(hasShiftContext)
            .map((shift) => (
              <p key={shift.id}>
                {requestShiftLabel(shift, outlet?.timeZone ?? "Asia/Jakarta")}
              </p>
            ))}
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t("hrisRequestsMine.peerResponse.contextMissing")}
        </p>
      )}
      {rejecting && (
        <label className="grid gap-2 text-sm">
          {t("hrisRequestsMine.peerResponse.rejectionReasonLabel")}
          <Textarea
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      )}
      {response.isError && (
        <p role="alert" className="text-sm text-danger">
          {t("hrisRequestsMine.peerResponse.error")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={blocked}
          onClick={() => {
            if (!blocked)
              response.mutate({ swapId: swap.id, action: "accept" });
          }}
        >
          {t("hrisRequestsMine.peerResponse.accept")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={blocked || (rejecting && reason.trim().length < 3)}
          onClick={() =>
            !blocked &&
            (rejecting
              ? response.mutate({
                  swapId: swap.id,
                  action: "reject",
                  rejectionReason: reason.trim(),
                })
              : setRejecting(true))
          }
        >
          {t("hrisRequestsQueue.detail.reject")}
        </Button>
      </div>
    </Card>
  );
}
