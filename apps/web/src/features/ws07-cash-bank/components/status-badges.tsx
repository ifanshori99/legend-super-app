// Status badges of the cash & bank screens: always icon + text (DESIGN.md,
// WCAG 1.4.1); the tone carries the same meaning everywhere.
import {
  Ban,
  CircleCheck,
  CircleDashed,
  Clock,
  FolderOpen,
  Link2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  CashDepositStatus,
  MatchStatus,
  ReconciliationCaseStatus,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  CASE_STATUS_KEYS,
  CASE_STATUS_TONES,
  DEPOSIT_STATUS_KEYS,
  DEPOSIT_STATUS_TONES,
  MATCH_STATUS_KEYS,
  MATCH_STATUS_TONES,
  type Tone,
} from "../lib";

const MATCH_ICONS: Record<MatchStatus, LucideIcon> = {
  unmatched: CircleDashed,
  auto_matched: CircleCheck,
  manually_matched: Link2,
  in_case: FolderOpen,
  excluded: Ban,
};

const CASE_ICONS: Record<ReconciliationCaseStatus, LucideIcon> = {
  open: CircleDashed,
  in_progress: Clock,
  resolved: CircleCheck,
  written_off: Ban,
};

const DEPOSIT_ICONS: Record<CashDepositStatus, LucideIcon> = {
  recorded: CircleDashed,
  matched: CircleCheck,
  discrepancy: XCircle,
};

function ToneBadge({
  tone,
  icon: Icon,
  label,
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

export function MatchStatusBadge({ status }: { status: MatchStatus }) {
  const t = useT();
  return (
    <ToneBadge
      tone={MATCH_STATUS_TONES[status]}
      icon={MATCH_ICONS[status]}
      label={t(MATCH_STATUS_KEYS[status])}
    />
  );
}

export function ReconciliationCaseStatusBadge({
  status,
}: {
  status: ReconciliationCaseStatus;
}) {
  const t = useT();
  return (
    <ToneBadge
      tone={CASE_STATUS_TONES[status]}
      icon={CASE_ICONS[status]}
      label={t(CASE_STATUS_KEYS[status])}
    />
  );
}

export function CashDepositStatusBadge({
  status,
}: {
  status: CashDepositStatus;
}) {
  const t = useT();
  return (
    <ToneBadge
      tone={DEPOSIT_STATUS_TONES[status]}
      icon={DEPOSIT_ICONS[status]}
      label={t(DEPOSIT_STATUS_KEYS[status])}
    />
  );
}
