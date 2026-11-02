// "Shift hari ini" on the Beranda (PRD §3 Kelompok D 33 Beranda: jadwal hari
// ini). The roster is published by schedule management; this card only reads
// the employee's own assignment for the outlet's business date.
import { CalendarOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useShiftToday } from "../hooks.ts";
import { formatShiftRange, shiftForDate } from "../state.ts";
import {
  InlineEmpty,
  SectionError,
  SectionSkeleton,
} from "./section-states.tsx";

export function ShiftToday({
  businessDate,
  timeZone,
}: {
  businessDate: string;
  timeZone: string;
}) {
  const t = useT();
  const shifts = useShiftToday(businessDate);
  const shift = shifts.data
    ? shiftForDate(shifts.data.data, businessDate)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("hris.home.shiftTitle")}</CardTitle>
      </CardHeader>
      {shifts.isPending ? (
        <SectionSkeleton rows={1} />
      ) : shifts.isError ? (
        <SectionError
          title={t("hris.state.shiftError")}
          description={t("hris.state.retryHint")}
          onRetry={() => void shifts.refetch()}
        />
      ) : shift ? (
        <div className="grid gap-1">
          <p className="tabular text-2xl leading-8 font-semibold tracking-tight">
            {formatShiftRange(shift, timeZone)}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("hris.home.shiftBreak", { minutes: shift.breakMinutes })}
          </p>
        </div>
      ) : (
        <InlineEmpty icon={CalendarOff} title={t("hris.home.shiftEmpty")} />
      )}
    </Card>
  );
}
