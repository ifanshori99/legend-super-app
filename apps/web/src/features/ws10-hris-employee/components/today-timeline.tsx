// Today's own attendance log stream, oldest first (PRD §3 Kelompok D 33
// Beranda "jadwal hari ini, tombol absen"; Alur L). A flagged or rejected log
// carries a StatusPill with icon + text, never color alone.
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import type { AttendanceLog } from "@starter/shared/hris";
import {
  formatTime,
  methodLabelKey,
  sortLogsAsc,
  typeShortLabelKey,
  validityLabelKey,
  validityStatus,
} from "../state.ts";
import { ATTENDANCE_TYPE_ICONS } from "./attendance-type-icon.ts";

export function TodayTimeline({
  logs,
  timeZone,
}: {
  logs: readonly AttendanceLog[];
  timeZone: string;
}) {
  const t = useT();
  const ordered = sortLogsAsc(logs);
  if (ordered.length === 0)
    return (
      <p className="text-sm leading-5 text-muted-foreground">
        {t("hris.home.timelineEmpty")}
      </p>
    );
  return (
    <ul className="divide-y">
      {ordered.map((log) => {
        const Icon = ATTENDANCE_TYPE_ICONS[log.type];
        return (
          <li key={log.id} className="flex items-center gap-3 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-5 font-medium">
                {t(typeShortLabelKey(log.type))}
              </p>
              <p className="truncate text-xs leading-4 text-muted-foreground">
                {t(methodLabelKey(log.method))}
                {log.geoDistanceM !== null && ` · ${log.geoDistanceM} m`}
              </p>
            </div>
            <div className="grid shrink-0 justify-items-end gap-1">
              <span className="tabular text-sm leading-5 font-semibold">
                {formatTime(log.occurredAt, timeZone)}
              </span>
              {log.validity !== "valid" && (
                <StatusPill status={validityStatus(log.validity)}>
                  {t(validityLabelKey(log.validity))}
                </StatusPill>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
