// Status presentation of a checklist task and of an employee's lifecycle
// state. A status is always icon + text, never color alone (WCAG 1.4.1,
// DESIGN.md §4).
//
// Task states use `Badge` with a tone: they are short labels the user acts on
// (the same pattern the inventory lists use). The employee's lifecycle state
// uses `StatusPill`, whose catalog supplies the tone per state; `delivered` is
// the catalog's neutral tone, used here for a finished employment that needs
// no attention.
import type { LucideIcon } from "lucide-react";
import {
  Ban,
  CircleCheck,
  CircleMinus,
  CircleSlash,
  CircleUser,
  Info,
  LogIn,
  TriangleAlert,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill, type StatusKind } from "@/components/ui/badge";
import type { ChecklistTaskStatus, EmployeeStatus } from "@starter/shared/hris";
import { EMPLOYEE_STATUS_LABEL, TASK_STATUS_LABEL } from "../lib.ts";

type BadgeTone = "neutral" | "success" | "warning" | "info";

const TASK_STATUS: Record<
  ChecklistTaskStatus,
  { tone: BadgeTone; icon: LucideIcon }
> = {
  open: { tone: "info", icon: Info },
  done: { tone: "success", icon: CircleCheck },
  blocked: { tone: "warning", icon: Ban },
  waived: { tone: "neutral", icon: CircleSlash },
};

export function TaskStatusBadge({ status }: { status: ChecklistTaskStatus }) {
  const t = useT();
  const { tone, icon: Icon } = TASK_STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(TASK_STATUS_LABEL[status])}
    </Badge>
  );
}

const EMPLOYEE_STATUS: Record<
  EmployeeStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  onboarding: { status: "info", icon: LogIn },
  active: { status: "success", icon: CircleUser },
  suspended: { status: "warning", icon: TriangleAlert },
  // `delivered` carries the catalog's neutral tone (no hue for a state that
  // needs nothing from the reader).
  resigned: { status: "delivered", icon: CircleMinus },
  terminated: { status: "danger", icon: CircleSlash },
};

export function EmployeeStatusPill({ status }: { status: EmployeeStatus }) {
  const t = useT();
  const { status: pill, icon } = EMPLOYEE_STATUS[status];
  return (
    <StatusPill status={pill} icon={icon}>
      {t(EMPLOYEE_STATUS_LABEL[status])}
    </StatusPill>
  );
}
