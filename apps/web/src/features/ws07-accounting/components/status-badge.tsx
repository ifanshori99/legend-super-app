// Status badges of the accounting screens: always icon + text (DESIGN.md,
// WCAG 1.4.1), and the tone carries the same meaning everywhere.
import {
  Archive,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  PauseCircle,
  PlayCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  ManualJournalStatus,
  RecurringJournalStatus,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { JOURNAL_STATUS_KEYS, RECURRING_STATUS_KEYS } from "../lib";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const MANUAL: Record<ManualJournalStatus, { tone: Tone; icon: LucideIcon }> = {
  draft: { tone: "neutral", icon: CircleDashed },
  pending_approval: { tone: "warning", icon: Clock },
  rejected: { tone: "danger", icon: XCircle },
  cancelled: { tone: "neutral", icon: Ban },
  posted: { tone: "success", icon: CircleCheck },
};

const RECURRING: Record<
  RecurringJournalStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  draft: { tone: "neutral", icon: CircleDashed },
  pending_approval: { tone: "warning", icon: Clock },
  rejected: { tone: "danger", icon: XCircle },
  active: { tone: "success", icon: PlayCircle },
  paused: { tone: "warning", icon: PauseCircle },
  ended: { tone: "neutral", icon: Archive },
};

export function ManualJournalStatusBadge({
  status,
}: {
  status: ManualJournalStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = MANUAL[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(JOURNAL_STATUS_KEYS[status])}
    </Badge>
  );
}

export function RecurringJournalStatusBadge({
  status,
}: {
  status: RecurringJournalStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = RECURRING[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(RECURRING_STATUS_KEYS[status])}
    </Badge>
  );
}

export function AccountStatusBadge({ active }: { active: boolean }) {
  const t = useT();
  return active ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t("accounting.coa.statusActive")}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <CircleSlash aria-hidden="true" />
      {t("accounting.coa.statusInactive")}
    </Badge>
  );
}
