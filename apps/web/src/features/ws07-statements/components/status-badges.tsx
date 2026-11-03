// Status of a fiscal period and of a reopen request, always icon + text
// (DESIGN.md §4 Status: colour alone never carries meaning).
import {
  Ban,
  CircleCheck,
  Clock,
  Lock,
  LockOpen,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  FiscalPeriodStatus,
  PeriodReopenRequestStatus,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  PERIOD_STATUS_KEYS,
  REOPEN_STATUS_KEYS,
} from "../lib";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const PERIOD: Record<FiscalPeriodStatus, { tone: Tone; icon: LucideIcon }> = {
  open: { tone: "info", icon: LockOpen },
  closed: { tone: "neutral", icon: Lock },
};

const REOPEN: Record<
  PeriodReopenRequestStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  pending: { tone: "warning", icon: Clock },
  approved: { tone: "success", icon: CircleCheck },
  rejected: { tone: "danger", icon: XCircle },
  cancelled: { tone: "neutral", icon: Ban },
};

export function PeriodStatusBadge({ status }: { status: FiscalPeriodStatus }) {
  const t = useT();
  const { tone, icon: Icon } = PERIOD[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(PERIOD_STATUS_KEYS[status])}
    </Badge>
  );
}

export function ReopenStatusBadge({
  status,
}: {
  status: PeriodReopenRequestStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = REOPEN[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(REOPEN_STATUS_KEYS[status])}
    </Badge>
  );
}
