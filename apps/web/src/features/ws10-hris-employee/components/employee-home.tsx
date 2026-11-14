// Beranda HRIS karyawan (bead legend-nv3y; PRD v1.7 §3 Kelompok D 33 "HRIS
// Self-Service Karyawan" Beranda). One scrolling column in the Hangat shell,
// mobile first: today's shift, the clock action, running requests and
// announcements. Data comes from hooks only.
import { CloudOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useFlushCorrectionQueue,
  useMyHrisProfile,
  usePositions,
  useQueuedCorrections,
} from "../hooks.ts";
import { isRefused } from "../queue.ts";
import { businessDateIn } from "../state.ts";
import { Announcements } from "./announcements.tsx";
import { AttendanceHero } from "./attendance-hero.tsx";
import { PendingCorrections } from "./pending-corrections.tsx";
import { ShiftToday } from "./shift-today.tsx";

function HomeSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <div className="grid gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-36" />
      </div>
      <Skeleton className="h-72 w-full rounded-container" />
      <Skeleton className="h-32 w-full rounded-container" />
      <Skeleton className="h-32 w-full rounded-container" />
    </div>
  );
}

export function EmployeeHome() {
  const t = useT();
  const profile = useMyHrisProfile();
  const positions = usePositions(profile.isSuccess);
  useFlushCorrectionQueue();
  // Refused entries are not waiting on the connection: the pending card shows
  // them with their own actions (legend-nvc7).
  const waiting = useQueuedCorrections().filter((row) => !isRefused(row));

  if (profile.isPending) return <HomeSkeleton />;
  if (profile.isError || !profile.data)
    return (
      <ErrorState
        title={t("hris.state.profileError")}
        description={t("hris.state.retryHint")}
        onRetry={() => void profile.refetch()}
      />
    );

  const { employee, outlet } = profile.data;
  const timeZone = outlet.timeZone;
  const businessDate = businessDateIn(timeZone);
  const positionName = positions.data?.data.find(
    (position) => position.id === employee.positionId,
  )?.name;

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="font-brand type-display-xl">
          {t("hris.home.greeting", { name: employee.fullName })}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {positionName
            ? t("hris.home.subtitle", {
                position: positionName,
                employeeNo: employee.employeeNo,
              })
            : t("hris.home.subtitleNoPosition", {
                employeeNo: employee.employeeNo,
              })}
        </p>
      </header>

      {waiting.length > 0 && (
        <div className="flex items-start gap-3 rounded-container bg-info-subtle p-3">
          <CloudOff
            className="mt-0.5 size-5 shrink-0 text-info"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold">
              {t("hris.home.queued", { count: waiting.length })}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("hris.home.queuedHint")}
            </p>
          </div>
        </div>
      )}

      <AttendanceHero businessDate={businessDate} timeZone={timeZone} />
      <ShiftToday businessDate={businessDate} timeZone={timeZone} />
      <PendingCorrections timeZone={timeZone} />
      <Announcements timeZone={timeZone} />
    </div>
  );
}
