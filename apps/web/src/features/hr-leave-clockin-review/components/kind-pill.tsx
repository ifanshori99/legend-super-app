// Case-kind pill shared by the queue and the detail summary (bead
// legend-3jem1), so one kind never reads as two different badges.
import {
  CalendarOff,
  PencilLine,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import type { MessageKey } from "@starter/shared/i18n";
import type { LeaveClockinCaseKind } from "../types.ts";

export const KIND_PILL: Record<
  LeaveClockinCaseKind,
  { labelKey: MessageKey; icon: LucideIcon }
> = {
  clock_in_on_leave: {
    labelKey: "leaveClockinReview.status.leaveClockIn",
    icon: CalendarOff,
  },
  manual_correction: {
    labelKey: "leaveClockinReview.status.manualCorrection",
    icon: PencilLine,
  },
  re_review: {
    labelKey: "leaveClockinReview.status.reReview",
    icon: RefreshCw,
  },
};

export function KindPill({ kind }: { kind: LeaveClockinCaseKind }) {
  const t = useT();
  const { labelKey, icon } = KIND_PILL[kind];
  return (
    <StatusPill
      status={kind === "re_review" ? "warning" : "info"}
      icon={icon}
      className="whitespace-nowrap"
    >
      {t(labelKey)}
    </StatusPill>
  );
}
