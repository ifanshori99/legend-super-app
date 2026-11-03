// Shared checklist status visuals: the run status pill and the OPS-01
// escalation badge (solid only for the state that already needs the
// supervisor; DESIGN.md §4 StatusPill, §5 "Operations — status hierarchy").
import { BellRing, Clock } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import type { ChecklistRunStatus } from "@starter/shared/operations";
import {
  statusLabelKey,
  statusPillKind,
  type ChecklistEscalation,
} from "../logic.ts";

export function RunStatusPill({
  status,
  className,
}: {
  status: ChecklistRunStatus;
  className?: string;
}) {
  const t = useT();
  return (
    <StatusPill status={statusPillKind(status)} className={className}>
      {t(statusLabelKey(status))}
    </StatusPill>
  );
}

/**
 * OPS-01: an unfinished run past its deadline gets the 15-minute grace
 * (`CHECKLIST_ALERT_GRACE_MINUTES`) before the supervisor report shows as
 * sent; a missed or failed run is already reported.
 */
export function EscalationBadge({
  escalation,
  className,
}: {
  escalation: ChecklistEscalation;
  className?: string;
}) {
  const t = useT();
  if (escalation === "none") return null;
  if (escalation === "grace")
    return (
      <StatusPill status="warning" icon={Clock} className={className}>
        {t("opsChecklist.runs.escalationGrace")}
      </StatusPill>
    );
  return (
    <StatusPill status="danger" solid icon={BellRing} className={className}>
      {t("opsChecklist.runs.escalationReported")}
    </StatusPill>
  );
}
