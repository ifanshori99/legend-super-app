// Quota and cap: the month's spend against the monthly cap, the warning or
// stop banner (state computed with the shared budgetState rule, so a cap
// change shows at once), and the daily limit per user. "Ubah" edits the caps.
import * as React from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import {
  AI_DEFAULT_DAILY_LIMIT,
  budgetState,
  type AiGovernanceSettings,
} from "@starter/shared/ai";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useBudget, useGovernance } from "../hooks";
import {
  budgetPercent,
  dailyLimitSummary,
  meterWidth,
  type LimitRange,
} from "../logic";
import { CapsDialog } from "./caps-dialog";
import { AdminCard, isOfflineError } from "./shared";

export function QuotaCard() {
  const t = useT();
  const governance = useGovernance(true);
  const budget = useBudget(true);
  const [editing, setEditing] = React.useState(false);

  if (governance.isPending) return <QuotaSkeleton />;
  if (governance.isError || !governance.data) {
    const offline = isOfflineError(governance.error);
    return (
      <AdminCard aria-labelledby="ai-quota-title">
        <h2 id="ai-quota-title" className="type-title">
          {t("aiAdmin.quota.title")}
        </h2>
        <ErrorState
          error={governance.error}
          title={t(
            offline ? "aiAdmin.error.offlineTitle" : "aiAdmin.quota.errorTitle",
          )}
          description={t(
            offline ? "aiAdmin.error.offlineHint" : "aiAdmin.quota.errorHint",
          )}
          onRetry={() => void governance.refetch()}
        />
      </AdminCard>
    );
  }

  const settings = governance.data.data;
  const usedIdr = budget.data?.data.budget.usedIdr ?? null;
  const cap = settings.monthlyBudgetIdr;
  const percent = usedIdr === null ? null : budgetPercent(usedIdr, cap);
  const state =
    usedIdr === null
      ? null
      : budgetState(
          usedIdr,
          cap,
          settings.budgetWarnPct,
          settings.budgetStopPct,
        );
  const limits = dailyLimitSummary(settings.features, AI_DEFAULT_DAILY_LIMIT);

  return (
    <AdminCard aria-labelledby="ai-quota-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="ai-quota-title" className="type-title">
            {t("aiAdmin.quota.title")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiAdmin.quota.description")}
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          {t("aiAdmin.quota.edit")}
        </Button>
      </div>

      <div className="grid gap-2 border-t border-border pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-base leading-6">
            {t("aiAdmin.quota.capLabel")}
          </span>
          <strong className="text-xl leading-7 font-semibold tabular">
            {percent === null ? "—" : `${percent}%`}
          </strong>
        </div>
        <div
          role="progressbar"
          aria-label={t("aiAdmin.quota.meterLabel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent ?? 0)}
          className="h-2.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={
              state === "stopped"
                ? "h-full bg-danger"
                : state === "warn"
                  ? "h-full bg-warning"
                  : "h-full bg-primary"
            }
            style={{ width: `${meterWidth(percent)}%` }}
          />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-base leading-6">
          {usedIdr === null ? (
            <span className="text-sm text-muted-foreground">
              {budget.isPending ? "…" : t("aiAdmin.quota.usageUnknown")}
            </span>
          ) : (
            <span className="tabular">
              {t("aiAdmin.quota.used", { amount: formatRupiah(usedIdr) })}
            </span>
          )}
          <span className="tabular">{formatRupiah(cap)}</span>
        </div>
        <Banner
          state={state}
          cap={cap}
          warn={settings.budgetWarnPct}
          stop={settings.budgetStopPct}
        />
      </div>

      <div className="grid gap-2 border-t border-border pt-4">
        <h3 className="text-base leading-6 font-semibold">
          {t("aiAdmin.quota.dailyTitle")}
        </h3>
        <LimitRow
          label={t("aiAdmin.quota.dailyEmployee")}
          range={limits.employee}
        />
        <LimitRow
          label={t("aiAdmin.quota.dailyManagement")}
          range={limits.management}
        />
      </div>

      <CapsDialog
        open={editing}
        settings={settings as AiGovernanceSettings}
        onClose={() => setEditing(false)}
      />
    </AdminCard>
  );
}

function Banner({
  state,
  cap,
  warn,
  stop,
}: {
  state: "ok" | "warn" | "stopped" | null;
  cap: number;
  warn: number;
  stop: number;
}) {
  const t = useT();
  if (state === null || state === "ok") return null;
  const stopped = state === "stopped";
  const Icon = stopped ? CircleAlert : TriangleAlert;
  const noCap = cap <= 0;
  const title = noCap
    ? "aiAdmin.quota.noCapTitle"
    : stopped
      ? "aiAdmin.quota.stoppedTitle"
      : "aiAdmin.quota.warnTitle";
  const body = noCap
    ? "aiAdmin.quota.noCapBody"
    : stopped
      ? "aiAdmin.quota.stoppedBody"
      : "aiAdmin.quota.warnBody";
  return (
    <div
      role={stopped ? "alert" : "status"}
      className={
        stopped
          ? "grid gap-1 rounded-control border-l-4 border-danger bg-danger-subtle p-3 text-danger"
          : "grid gap-1 rounded-control border-l-4 border-warning bg-warning-subtle p-3 text-warning"
      }
    >
      <strong className="flex items-center gap-1.5 text-base leading-6 font-semibold">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {t(title as MessageKey)}
      </strong>
      <p className="text-sm leading-5 text-foreground">
        {t(body as MessageKey, { warn, stop })}
      </p>
    </div>
  );
}

function LimitRow({ label, range }: { label: string; range: LimitRange }) {
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-3 text-base leading-6">
      <span>{label}</span>
      <strong className="font-semibold tabular">
        {range.min === range.max
          ? t("aiAdmin.quota.dailyValue", { count: range.min })
          : t("aiAdmin.quota.dailyRange", { min: range.min, max: range.max })}
      </strong>
    </div>
  );
}

function QuotaSkeleton() {
  return (
    <AdminCard aria-busy="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </AdminCard>
  );
}
