// Review K P1 (bead legend-wasr7.8): every shift still open on the day close
// screen links to its supervisor screen, where a shift whose tablet holds an
// offline queue (or is lost) is force closed. The cafe is never locked.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import type { ActiveShift } from "../../types";
import { formatShiftTime } from "../shift/shift-format";

export function OpenShiftLinks({
  shifts,
  timeZone,
}: {
  shifts: readonly Pick<ActiveShift, "id" | "shiftNo" | "openedAt">[];
  timeZone: string;
}) {
  const t = useT();
  if (shifts.length === 0) return null;
  return (
    <ul
      aria-label={t("posKasirOffline.dayClose.openShiftsLabel")}
      className="grid gap-1"
    >
      {shifts.map((shift) => (
        <li key={shift.id}>
          <Link
            to="/pos/supervisor/shift/$shiftId"
            params={{ shiftId: shift.id }}
            className="tabular font-semibold underline underline-offset-4"
          >
            {t("posKasirOffline.dayClose.openShift", {
              shiftNo: shift.shiftNo,
              time: formatShiftTime(shift.openedAt, timeZone),
            })}
          </Link>
        </li>
      ))}
    </ul>
  );
}
