// Tenant usage of one month: budget banner and meter, headline numbers, the
// per-feature table (stacked cards on phones) and blocked-by-reason list
// (AIG-02). Read-only; the caps are changed on the settings page.
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { AiTenantUsage } from "@starter/shared/ai";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { budgetPercent } from "./logic.ts";
import { blockedReasonKey, featureLabelKey } from "./usage-format";
import { useTenantUsage } from "./usage-hooks";

export function UsageSummary({ month }: { month: string }) {
  const t = useT();
  const usage = useTenantUsage(month);

  if (usage.isPending) return <UsageSkeleton />;
  if (usage.isError)
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            error={usage.error}
            title={t("aiAdminUsage.error.title")}
            description={t("aiAdminUsage.error.hint")}
            onRetry={() => void usage.refetch()}
          />
        </CardShellBody>
      </CardShell>
    );

  const data = usage.data.data;
  const isEmptyMonth = data.byFeature.length === 0 && data.mcpToolCalls === 0;
  return (
    <div className="grid min-w-0 gap-4">
      <BudgetCard budget={data.budget} />
      {isEmptyMonth ? (
        <CardShell>
          <CardShellBody>
            <EmptyState
              title={t("aiAdminUsage.empty.title")}
              description={t("aiAdminUsage.empty.hint")}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <>
          <Totals data={data} />
          <FeatureTable data={data} />
          <BlockedReasons data={data} />
        </>
      )}
    </div>
  );
}

function UsageSkeleton() {
  const t = useT();
  return (
    <div className="grid gap-4" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-36 rounded-shell" />
      <Skeleton className="h-28 rounded-shell" />
      <Skeleton className="h-64 rounded-shell" />
    </div>
  );
}

function BudgetCard({ budget }: { budget: AiTenantUsage["budget"] }) {
  const t = useT();
  const percent = budgetPercent(budget.usedIdr, budget.monthlyBudgetIdr);
  const barWidth = percent === null ? 0 : Math.min(100, percent);
  const barTone =
    budget.state === "stopped"
      ? "bg-danger"
      : budget.state === "warn"
        ? "bg-warning"
        : "bg-primary";
  return (
    <CardShell>
      <CardShellBody className="gap-4 p-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="type-title">{t("aiAdminUsage.budget.title")}</h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("aiAdminUsage.budget.hint")}
            </p>
          </div>
          {percent !== null && (
            <p className="type-money-display tabular">{percent}%</p>
          )}
        </div>

        {percent === null ? (
          <p className="text-sm text-muted-foreground">
            {t("aiAdminUsage.budget.noCap")}
          </p>
        ) : (
          <div className="grid gap-2">
            <div
              role="progressbar"
              aria-label={t("aiAdminUsage.budget.percentLabel")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, percent)}
              className="h-2 overflow-hidden rounded-full bg-surface-3"
            >
              <div
                className={`h-full rounded-full ${barTone}`}
                style={{ width: `${barWidth}%` }}
              />
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-sm">
              <span>
                {t("aiAdminUsage.budget.used", {
                  amount: formatRupiah(budget.usedIdr),
                })}
              </span>
              <span className="text-muted-foreground">
                {t("aiAdminUsage.budget.cap", {
                  amount: formatRupiah(budget.monthlyBudgetIdr),
                })}
              </span>
            </div>
          </div>
        )}

        {budget.state === "warn" && (
          <div
            role="status"
            className="flex gap-2.5 rounded-control border-l-4 border-warning bg-warning-subtle px-3.5 py-3 text-sm text-warning"
          >
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              <strong>{t("aiAdminUsage.budget.warnTitle")}</strong>
              <br />
              {t("aiAdminUsage.budget.warnBody", {
                warnPct: budget.warnPct,
                stopPct: budget.stopPct,
              })}
            </p>
          </div>
        )}
        {budget.state === "stopped" && (
          <div
            role="alert"
            className="flex gap-2.5 rounded-control border-l-4 border-danger bg-danger-subtle px-3.5 py-3 text-sm text-danger"
          >
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              <strong>{t("aiAdminUsage.budget.stoppedTitle")}</strong>
              <br />
              {t("aiAdminUsage.budget.stoppedBody")}
            </p>
          </div>
        )}
      </CardShellBody>
    </CardShell>
  );
}

function Totals({ data }: { data: AiTenantUsage }) {
  const t = useT();
  const sum = (pick: (row: AiTenantUsage["byFeature"][number]) => number) =>
    data.byFeature.reduce((total, row) => total + pick(row), 0);
  const tokensIn = sum((row) => row.tokensIn);
  const tokensOut = sum((row) => row.tokensOut);
  return (
    <StatStrip label={t("aiAdminUsage.stats.label")} columns={4}>
      <StatTile
        label={t("aiAdminUsage.stats.jobs")}
        value={<NumberDisplay value={sum((row) => row.jobs)} size="stat" />}
      />
      <StatTile
        label={t("aiAdminUsage.stats.blocked")}
        value={
          <NumberDisplay value={sum((row) => row.blockedJobs)} size="stat" />
        }
      />
      <StatTile
        label={t("aiAdminUsage.stats.cost")}
        value={<Money amount={sum((row) => row.costIdr)} size="stat" />}
        context={t("aiAdminUsage.stats.tokensHint", {
          tokensIn: formatNumber(tokensIn),
          tokensOut: formatNumber(tokensOut),
        })}
      />
      <StatTile
        label={t("aiAdminUsage.stats.mcp")}
        value={<NumberDisplay value={data.mcpToolCalls} size="stat" />}
      />
    </StatStrip>
  );
}

function FeatureTable({ data }: { data: AiTenantUsage }) {
  const t = useT();
  return (
    <CardShell>
      <CardShellBody>
        <header className="border-b p-card">
          <h3 className="type-title">{t("aiAdminUsage.feature.title")}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiAdminUsage.feature.hint")}
          </p>
        </header>
        {data.byFeature.length === 0 ? (
          <EmptyState
            title={t("aiAdminUsage.feature.emptyTitle")}
            description={t("aiAdminUsage.feature.emptyHint")}
          />
        ) : (
          <>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("aiAdminUsage.feature.columns.feature")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("aiAdminUsage.feature.columns.jobs")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("aiAdminUsage.feature.columns.blocked")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("aiAdminUsage.feature.columns.tokensIn")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("aiAdminUsage.feature.columns.tokensOut")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("aiAdminUsage.feature.columns.cost")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byFeature.map((row) => (
                    <TableRow key={row.feature}>
                      <TableCell>
                        <p className="font-semibold">
                          {t(featureLabelKey(row.feature))}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {row.feature}
                        </p>
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatNumber(row.jobs)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatNumber(row.blockedJobs)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatNumber(row.tokensIn)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatNumber(row.tokensOut)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money amount={row.costIdr} size="sm" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="divide-y divide-border sm:hidden">
              {data.byFeature.map((row) => (
                <li key={row.feature} className="grid gap-2 p-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {t(featureLabelKey(row.feature))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.feature}
                      </p>
                    </div>
                    <Money amount={row.costIdr} size="sm" />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <Pair
                      label={t("aiAdminUsage.feature.columns.jobs")}
                      value={formatNumber(row.jobs)}
                    />
                    <Pair
                      label={t("aiAdminUsage.feature.columns.blocked")}
                      value={formatNumber(row.blockedJobs)}
                    />
                    <Pair
                      label={t("aiAdminUsage.feature.columns.tokensIn")}
                      value={formatNumber(row.tokensIn)}
                    />
                    <Pair
                      label={t("aiAdminUsage.feature.columns.tokensOut")}
                      value={formatNumber(row.tokensOut)}
                    />
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardShellBody>
    </CardShell>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function BlockedReasons({ data }: { data: AiTenantUsage }) {
  const t = useT();
  return (
    <CardShell>
      <CardShellBody>
        <header className="border-b p-card">
          <h3 className="type-title">
            {t("aiAdminUsage.blockedReasons.title")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiAdminUsage.blockedReasons.hint")}
          </p>
        </header>
        {data.blockedByReason.length === 0 ? (
          <p className="p-card text-sm text-muted-foreground">
            {t("aiAdminUsage.blockedReasons.none")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.blockedByReason.map((entry) => (
              <li
                key={entry.reason}
                className="flex items-center justify-between gap-3 px-card py-3"
              >
                <span>{t(blockedReasonKey(entry.reason))}</span>
                <Badge tone="neutral">
                  {t("aiAdminUsage.blockedReasons.count", {
                    count: formatNumber(entry.count),
                  })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardShellBody>
    </CardShell>
  );
}
