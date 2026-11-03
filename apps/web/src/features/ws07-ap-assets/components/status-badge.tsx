// Status pills of the AP/AR, fixed-asset and budget screens: always icon +
// text (DESIGN.md, WCAG 1.4.1), and the tone carries the same meaning
// everywhere.
import {
  Archive,
  ArrowDownRight,
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { DepreciationRun, FixedAsset } from "@starter/shared/accounting";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { varianceState, type VarianceState } from "../lib";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const ASSET: Record<
  FixedAsset["status"],
  { tone: Tone; icon: LucideIcon; labelKey: MessageKey }
> = {
  active: {
    tone: "success",
    icon: CircleCheck,
    labelKey: "accounting.ap.assets.status.active",
  },
  fully_depreciated: {
    tone: "info",
    icon: CircleCheck,
    labelKey: "accounting.ap.assets.status.fully_depreciated",
  },
  disposed: {
    tone: "neutral",
    icon: Archive,
    labelKey: "accounting.ap.assets.status.disposed",
  },
};

export function AssetStatusBadge({ status }: { status: FixedAsset["status"] }) {
  const t = useT();
  const { tone, icon: Icon, labelKey } = ASSET[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(labelKey)}
    </Badge>
  );
}

export function DepreciationRunStatusBadge({
  run,
}: {
  run: Pick<DepreciationRun, "journalEntryId">;
}) {
  const t = useT();
  return run.journalEntryId !== null ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t("accounting.ap.depreciation.status.posted")}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <CircleDashed aria-hidden="true" />
      {t("accounting.ap.depreciation.status.draft")}
    </Badge>
  );
}

const VARIANCE: Record<
  VarianceState,
  { tone: Tone; icon: LucideIcon; labelKey: MessageKey }
> = {
  under: {
    tone: "info",
    icon: ArrowDownRight,
    labelKey: "accounting.ap.budgets.variance.under",
  },
  on: {
    tone: "success",
    icon: CircleCheck,
    labelKey: "accounting.ap.budgets.variance.on",
  },
  over: {
    tone: "warning",
    icon: ArrowUpRight,
    labelKey: "accounting.ap.budgets.variance.over",
  },
};

export function BudgetVarianceBadge({ varianceIdr }: { varianceIdr: number }) {
  const t = useT();
  const state = varianceState(varianceIdr);
  const { tone, icon: Icon, labelKey } = VARIANCE[state];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(labelKey)}
    </Badge>
  );
}

export function AgingRowStatusBadge({ overdue }: { overdue: boolean }) {
  const t = useT();
  return overdue ? (
    <Badge tone="warning">
      <TriangleAlert aria-hidden="true" />
      {t("accounting.ap.aging.rowOverdue")}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Clock aria-hidden="true" />
      {t("accounting.ap.aging.buckets.current")}
    </Badge>
  );
}
