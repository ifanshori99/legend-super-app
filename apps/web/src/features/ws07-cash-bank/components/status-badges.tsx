// Status badges of the cash & bank screens: always icon + text (DESIGN.md,
// WCAG 1.4.1); the tone carries the same meaning everywhere.
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Ban,
  CircleCheck,
  CircleDashed,
  Clock,
  ExternalLink,
  FolderOpen,
  Link2,
  Wallet,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  CashBankEntryKind,
  CashBankEntryStatus,
  CashDepositStatus,
  MatchStatus,
  PettyCashJournalStatus,
  ReconciliationCaseStatus,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  CASE_STATUS_KEYS,
  CASE_STATUS_TONES,
  CASH_ENTRY_KIND_KEYS,
  CASH_ENTRY_KIND_TONES,
  CASH_ENTRY_STATUS_KEYS,
  CASH_ENTRY_STATUS_TONES,
  DEPOSIT_STATUS_KEYS,
  DEPOSIT_STATUS_TONES,
  MATCH_STATUS_KEYS,
  MATCH_STATUS_TONES,
  PETTY_JOURNAL_KEYS,
  PETTY_JOURNAL_TONES,
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

const ENTRY_KIND_ICONS: Record<CashBankEntryKind, LucideIcon> = {
  cash_in: ArrowDownLeft,
  cash_out: ArrowUpRight,
  transfer: ArrowLeftRight,
  petty_topup: Wallet,
};

export function CashEntryKindBadge({ kind }: { kind: CashBankEntryKind }) {
  const t = useT();
  return (
    <ToneBadge
      tone={CASH_ENTRY_KIND_TONES[kind]}
      icon={ENTRY_KIND_ICONS[kind]}
      label={t(CASH_ENTRY_KIND_KEYS[kind])}
    />
  );
}

const ENTRY_STATUS_ICONS: Record<CashBankEntryStatus, LucideIcon> = {
  pending_approval: Clock,
  approved: CircleCheck,
  rejected: XCircle,
};

export function CashEntryStatusBadge({
  status,
}: {
  status: CashBankEntryStatus;
}) {
  const t = useT();
  return (
    <ToneBadge
      tone={CASH_ENTRY_STATUS_TONES[status]}
      icon={ENTRY_STATUS_ICONS[status]}
      label={t(CASH_ENTRY_STATUS_KEYS[status])}
    />
  );
}

const PETTY_JOURNAL_ICONS: Record<PettyCashJournalStatus, LucideIcon> = {
  posted: CircleCheck,
  parked: Clock,
  external: ExternalLink,
};

export function PettyJournalBadge({
  status,
}: {
  status: PettyCashJournalStatus;
}) {
  const t = useT();
  return (
    <ToneBadge
      tone={PETTY_JOURNAL_TONES[status]}
      icon={PETTY_JOURNAL_ICONS[status]}
      label={t(PETTY_JOURNAL_KEYS[status])}
    />
  );
}
