// The Beranda hero: today's attendance state, the log stream and the one
// primary clock action (PRD §3 Kelompok D 33 Beranda; §4 Alur L "tiga
// ketukan": Beranda → selfie → kirim). Warm density, pill CTA.
import { Link } from "@tanstack/react-router";
import { Coffee, LogIn, LogOut, Play, type LucideIcon } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AttendanceType } from "@starter/shared/hris";
import { useAttendanceDay } from "../hooks.ts";
import {
  dayStatus,
  dayStatusTitleKey,
  formatTime,
  primaryClockType,
  secondaryClockType,
  sortLogsAsc,
} from "../state.ts";
import { SectionError, SectionSkeleton } from "./section-states.tsx";
import { TodayTimeline } from "./today-timeline.tsx";

const ACTION_ICONS: Record<AttendanceType, LucideIcon> = {
  in: LogIn,
  out: LogOut,
  break_start: Coffee,
  break_end: Play,
};

const ACTION_LABEL_KEYS = {
  in: "hris.home.clockIn",
  out: "hris.home.clockOut",
  break_start: "hris.home.startBreak",
  break_end: "hris.home.endBreak",
} as const;

export function AttendanceHero({
  businessDate,
  timeZone,
}: {
  businessDate: string;
  timeZone: string;
}) {
  const t = useT();
  const day = useAttendanceDay(businessDate);

  if (day.isPending)
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("hris.home.attendanceTitle")}</CardTitle>
        </CardHeader>
        <SectionSkeleton rows={3} />
      </Card>
    );
  if (day.isError)
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("hris.home.attendanceTitle")}</CardTitle>
        </CardHeader>
        <SectionError
          title={t("hris.state.logsError")}
          description={t("hris.state.retryHint")}
          onRetry={() => void day.refetch()}
        />
      </Card>
    );

  const logs = day.data.data;
  const ordered = sortLogsAsc(logs).filter(
    (log) => log.validity !== "rejected",
  );
  const status = dayStatus(logs);
  const primary = primaryClockType(status);
  const secondary = secondaryClockType(status);
  const lastEntry = ordered.at(-1);
  const lastIn = ordered.filter((log) => log.type === "in").at(-1);
  const dateHint =
    status === "not_started"
      ? t("hris.home.notStartedHint")
      : status === "working"
        ? t("hris.home.workingSince", {
            time: lastIn ? formatTime(lastIn.occurredAt, timeZone) : "—",
          })
        : status === "on_break"
          ? t("hris.home.onBreakSince", {
              time: lastEntry
                ? formatTime(lastEntry.occurredAt, timeZone)
                : "—",
            })
          : t("hris.home.finishedAt", {
              time: lastEntry
                ? formatTime(lastEntry.occurredAt, timeZone)
                : "—",
            });
  const PrimaryIcon = ACTION_ICONS[primary];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("hris.home.attendanceTitle")}</CardTitle>
        <CardDescription>{dateHint}</CardDescription>
        <CardAction>
          <StatusPill
            status={
              status === "not_started"
                ? "info"
                : status === "on_break"
                  ? "warning"
                  : "success"
            }
          >
            {t(dayStatusTitleKey(status))}
          </StatusPill>
        </CardAction>
      </CardHeader>

      <TodayTimeline logs={logs} timeZone={timeZone} />

      <div className="grid gap-2">
        <Button asChild size="lg" className="w-full">
          <Link to="/karyawan/absensi" search={{ type: primary }}>
            <PrimaryIcon aria-hidden="true" />
            {t(ACTION_LABEL_KEYS[primary])}
          </Link>
        </Button>
        {secondary && (
          <Button asChild size="lg" variant="outline" className="w-full">
            <Link to="/karyawan/absensi" search={{ type: secondary }}>
              <Coffee aria-hidden="true" />
              {t(ACTION_LABEL_KEYS[secondary])}
            </Link>
          </Button>
        )}
        <Button asChild variant="ghost" className="w-full">
          <Link to="/karyawan/absensi/riwayat">{t("hris.home.viewHistory")}</Link>
        </Button>
      </div>
    </Card>
  );
}
