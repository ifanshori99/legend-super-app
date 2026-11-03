// Status badges of the profit-share screens: always icon + text (DESIGN.md,
// WCAG 1.4.1), and the tone carries the same meaning everywhere. The version
// and run states come from the contract enums, never from local guesses.
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  Wallet,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  DistributionLinePaymentStatus,
  DistributionRunStatus,
  ShareAllocationVersionStatus,
  ShareholderStatus,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  PAYMENT_STATUS_KEYS,
  RUN_STATUS_KEYS,
  SHAREHOLDER_STATUS_KEYS,
  VERSION_STATUS_KEYS,
} from "../lib";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const VERSION: Record<
  ShareAllocationVersionStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  draft: { tone: "neutral", icon: CircleDashed },
  pending_approval: { tone: "warning", icon: Clock },
  approved: { tone: "success", icon: CircleCheck },
  rejected: { tone: "danger", icon: XCircle },
  cancelled: { tone: "neutral", icon: Ban },
};

const RUN: Record<DistributionRunStatus, { tone: Tone; icon: LucideIcon }> = {
  draft: { tone: "neutral", icon: CircleDashed },
  pending_approval: { tone: "warning", icon: Clock },
  approved: { tone: "success", icon: CircleCheck },
  paid: { tone: "success", icon: Wallet },
  cancelled: { tone: "neutral", icon: Ban },
};

const PAYMENT: Record<
  DistributionLinePaymentStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  pending: { tone: "warning", icon: Clock },
  paid: { tone: "success", icon: CircleCheck },
};

export function VersionStatusBadge({
  status,
}: {
  status: ShareAllocationVersionStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = VERSION[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(VERSION_STATUS_KEYS[status])}
    </Badge>
  );
}

export function RunStatusBadge({ status }: { status: DistributionRunStatus }) {
  const t = useT();
  const { tone, icon: Icon } = RUN[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(RUN_STATUS_KEYS[status])}
    </Badge>
  );
}

export function PaymentStatusBadge({
  status,
}: {
  status: DistributionLinePaymentStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = PAYMENT[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(PAYMENT_STATUS_KEYS[status])}
    </Badge>
  );
}

export function ShareholderStatusBadge({
  status,
}: {
  status: ShareholderStatus;
}) {
  const t = useT();
  return status === "active" ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t(SHAREHOLDER_STATUS_KEYS.active)}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <CircleSlash aria-hidden="true" />
      {t(SHAREHOLDER_STATUS_KEYS.inactive)}
    </Badge>
  );
}
