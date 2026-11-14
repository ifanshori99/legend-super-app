// Siap bayar: locked runs of the PT that still need paying, with the one next
// step for each (prepare, send for approval, review, see status) and a side
// panel that keeps salary received apart from the PT fee. The server decides
// every step; a disabled or hidden button here is only clarity, and a refusal
// is always shown (docs/briefs/sub-payout-finance-ui.md "Aturan keras").
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { CircleAlert, ClipboardList } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@starter/shared/i18n";
import type { PayableRun } from "../api";
import { isPayoutOffline, payoutErrorMessage } from "../errors";
import {
  useCreateBatch,
  useEntityBatches,
  usePayoutConfig,
  usePayoutSourceAccounts,
  usePayoutUserNames,
  useSubmitBatch,
} from "../hooks";
import {
  batchFeeTotal,
  batchFundsNeeded,
  batchStatusMeta,
  isOpenBatch,
  periodMonthLabel,
  type PayoutTabProps,
} from "../lib";
import { formatDateTime } from "../../ws10-payroll-run/lib";

type RunRow = { run: PayableRun; batch: PayrollDisbursementBatchDto | null };

/** The newest batch that is still alive; a cancelled one lets the run restart. */
function activeBatch(batches: readonly PayrollDisbursementBatchDto[]) {
  return (
    [...batches]
      .filter((batch) => isOpenBatch(batch.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

function runTitleKey(type: PayableRun["runType"]) {
  return type === "thr"
    ? "payrollPayout.runs.title.thr"
    : type === "off_cycle"
      ? "payrollPayout.runs.title.offCycle"
      : "payrollPayout.runs.title.regular";
}

export function RunsTab({
  legalEntityId,
  access,
  onSelectBatch,
}: PayoutTabProps) {
  const t = useT();
  const entries = useEntityBatches(legalEntityId);
  const config = usePayoutConfig(legalEntityId);
  const accounts = usePayoutSourceAccounts(legalEntityId);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const rows: RunRow[] = entries.entries.map(({ run, batches }) => ({
    run,
    batch: activeBatch(batches),
  }));
  const selected =
    rows.find((row) => row.run.id === selectedId) ?? rows[0] ?? null;

  if (entries.isPending) return <RunsSkeleton />;
  if (entries.isError)
    return (
      <ErrorState
        title={t(
          isPayoutOffline(entries.error)
            ? "payrollPayout.error.offlineTitle"
            : "payrollPayout.runs.error.title",
        )}
        description={t("payrollPayout.runs.error.description")}
        error={entries.error}
        onRetry={() => void entries.refetch()}
      />
    );

  const cfg = config.data ?? null;
  const duitkuActive =
    cfg !== null &&
    cfg.method === "duitku" &&
    cfg.enabled &&
    cfg.integrationId !== null;
  const source = accounts.data?.find(
    (account) => account.id === cfg?.manualSourceBankAccountId,
  );
  // Why a new batch cannot start yet; the server re-checks all of it.
  const blocked: MessageKey | null =
    config.isPending || accounts.isPending
      ? null
      : cfg === null
        ? "payrollPayout.runs.blocked.noConfig"
        : !cfg.enabled
          ? "payrollPayout.runs.blocked.disabled"
          : !duitkuActive && source && !source.active
            ? "payrollPayout.runs.blocked.sourceInactive"
            : null;

  return (
    <div className="grid min-w-0 gap-4">
      {!duitkuActive && !config.isPending && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-container border-(length:--border-w) bg-warning-subtle p-card text-warning"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="grid min-w-0 gap-1 text-sm leading-5">
            <p className="font-semibold">
              {t("payrollPayout.runs.duitkuOff.title")}
            </p>
            <p>
              {t("payrollPayout.runs.duitkuOff.body")}{" "}
              <Link
                to="/kelola/payroll/pencairan"
                search={{ tab: "settings", entity: legalEntityId }}
                className="font-semibold underline underline-offset-2"
              >
                {t("payrollPayout.runs.duitkuOff.link")}
              </Link>
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <section className="rounded-container border-(length:--border-w) bg-card shadow-hairline">
          <EmptyState
            icon={ClipboardList}
            title={t("payrollPayout.runs.empty.title")}
            description={t("payrollPayout.runs.empty.description")}
          />
        </section>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <section
            aria-labelledby="payout-runs-title"
            className="min-w-0 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="payout-runs-title" className="type-title">
                  {t("payrollPayout.runs.title.list")}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("payrollPayout.runs.subtitle")}
                </p>
              </div>
              <Badge tone="neutral">
                {t("payrollPayout.runs.count", { count: rows.length })}
              </Badge>
            </div>
            <ul className="mt-4 divide-y divide-border">
              {rows.map((row) => (
                <RunItem
                  key={row.run.id}
                  row={row}
                  selected={selected?.run.id === row.run.id}
                  onFocusRun={() => setSelectedId(row.run.id)}
                  blocked={blocked}
                  canRequest={access.canRequest}
                  legalEntityId={legalEntityId}
                  onSelectBatch={onSelectBatch}
                />
              ))}
            </ul>
            <div className="mt-2 rounded-field bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
              <p className="font-semibold text-foreground">
                {t("payrollPayout.runs.twoPeople.title")}
              </p>
              <p>{t("payrollPayout.runs.twoPeople.body")}</p>
            </div>
          </section>
          {selected && (
            <SelectedPanel
              row={selected}
              duitkuActive={duitkuActive}
              sourceLabel={
                source
                  ? `${source.label.split(" · ")[0]} ${source.maskedNumber}`
                  : null
              }
              feePerTransfer={cfg?.feePerTransferIdr ?? 0}
              canRequest={access.canRequest}
              blocked={blocked}
              legalEntityId={legalEntityId}
              onSelectBatch={onSelectBatch}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---- One run ------------------------------------------------------------------

function RunItem({
  row,
  selected,
  onFocusRun,
  blocked,
  canRequest,
  legalEntityId,
  onSelectBatch,
}: {
  row: RunRow;
  selected: boolean;
  onFocusRun: () => void;
  blocked: MessageKey | null;
  canRequest: boolean;
  legalEntityId: string;
  onSelectBatch: PayoutTabProps["onSelectBatch"];
}) {
  const t = useT();
  const names = usePayoutUserNames();
  const { run, batch } = row;
  const meta = batch ? batchStatusMeta(batch.status) : null;
  const asker = batch ? (names.get(batch.requestedBy) ?? null) : null;
  return (
    <li
      aria-current={selected || undefined}
      className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta?.kind ?? "neutral"}>
            {t(meta?.labelKey ?? "payrollPayout.runs.readyToPrepare")}
          </Badge>
          <span className="text-sm text-muted-foreground tabular">
            {run.code}
          </span>
        </div>
        <button
          type="button"
          onClick={onFocusRun}
          className="w-fit rounded-field text-left text-lg leading-6 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t(runTitleKey(run.runType), {
            period: periodMonthLabel(run.periodStart),
          })}
        </button>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollPayout.runs.employeeCount", {
            count: formatNumber(run.employeeCount),
          })}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {batch
            ? asker
              ? t("payrollPayout.runs.askedBy", {
                  name: asker,
                  at: formatDateTime(batch.requestedAt),
                })
              : t("payrollPayout.runs.askedAt", {
                  at: formatDateTime(batch.requestedAt),
                })
            : run.lockedAt
              ? t("payrollPayout.runs.lockedAt", {
                  at: formatDateTime(run.lockedAt),
                })
              : null}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="grid sm:text-right">
          <Money amount={run.netIdr} size="lg" />
          <span className="text-xs leading-4 text-muted-foreground">
            {t("payrollPayout.runs.netLabel")}
          </span>
        </div>
        <RunAction
          row={row}
          blocked={blocked}
          canRequest={canRequest}
          legalEntityId={legalEntityId}
          onSelectBatch={onSelectBatch}
          compact
        />
      </div>
    </li>
  );
}

/** The single next step of a run. Errors from the server stay on screen. */
function RunAction({
  row,
  blocked,
  canRequest,
  legalEntityId,
  onSelectBatch,
  compact = false,
}: {
  row: RunRow;
  blocked: MessageKey | null;
  canRequest: boolean;
  legalEntityId: string;
  onSelectBatch: PayoutTabProps["onSelectBatch"];
  compact?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateBatch(row.run.id);
  const submit = useSubmitBatch();
  const { batch } = row;
  const size = compact ? "sm" : "default";
  const touch = "min-h-11 sm:min-h-0";
  const pending = create.isPending || submit.isPending;
  const failure = create.error ?? submit.error;

  let action: React.ReactNode;
  if (batch === null || batch.status === "cancelled") {
    action = !canRequest ? (
      <p className="max-w-48 text-xs leading-4 text-muted-foreground">
        {t("payrollPayout.runs.needRequestPermission")}
      </p>
    ) : blocked ? (
      <>
        <p className="max-w-56 text-right text-xs leading-4 text-muted-foreground">
          {t(blocked)}
        </p>
        <Button asChild variant="outline" size={size} className={touch}>
          <Link
            to="/kelola/payroll/pencairan"
            search={{ tab: "settings", entity: legalEntityId }}
          >
            {t("payrollPayout.runs.goSettings")}
          </Link>
        </Button>
      </>
    ) : (
      <Button
        type="button"
        variant="outline"
        size={size}
        className={touch}
        loading={create.isPending}
        disabled={pending}
        onClick={() =>
          create.mutate(
            { channel: "manual_bank" },
            {
              onSuccess: () =>
                toast({
                  title: t("payrollPayout.runs.prepared"),
                  tone: "success",
                }),
            },
          )
        }
      >
        {t("payrollPayout.runs.prepare")}
      </Button>
    );
  } else if (batch.status === "draft") {
    action = canRequest ? (
      <Button
        type="button"
        size={size}
        className={touch}
        loading={submit.isPending}
        disabled={pending}
        onClick={() =>
          submit.mutate(
            { batchId: batch.id },
            {
              onSuccess: ({ data }) =>
                toast({
                  title: t("payrollPayout.runs.submitted"),
                  description:
                    data.excluded.length > 0
                      ? t("payrollPayout.runs.submittedExcluded", {
                          count: data.excluded.length,
                        })
                      : undefined,
                  tone: "success",
                }),
            },
          )
        }
      >
        {t("payrollPayout.runs.submit")}
      </Button>
    ) : null;
  } else {
    const review = batch.status === "pending_approval";
    action = (
      <Button
        type="button"
        variant={review ? "default" : "outline"}
        size={size}
        className={touch}
        onClick={() => onSelectBatch(batch.id, batch.status)}
      >
        {t(
          review ? "payrollPayout.runs.review" : "payrollPayout.runs.seeStatus",
        )}
      </Button>
    );
  }

  return (
    <div className="grid justify-items-end gap-2">
      {action}
      {failure && (
        <p
          role="alert"
          className="max-w-64 text-right text-xs leading-4 text-danger"
        >
          {payoutErrorMessage(failure, t)}
        </p>
      )}
    </div>
  );
}

// ---- Side panel -----------------------------------------------------------------

function SelectedPanel({
  row,
  duitkuActive,
  sourceLabel,
  feePerTransfer,
  canRequest,
  blocked,
  legalEntityId,
  onSelectBatch,
}: {
  row: RunRow;
  duitkuActive: boolean;
  sourceLabel: string | null;
  feePerTransfer: number;
  canRequest: boolean;
  blocked: MessageKey | null;
  legalEntityId: string;
  onSelectBatch: PayoutTabProps["onSelectBatch"];
}) {
  const t = useT();
  const { run, batch } = row;
  // The fee is the PT's cost and never comes out of the salary received.
  const live = batch !== null && batch.status !== "cancelled";
  const fee = live ? batchFeeTotal(batch) : run.employeeCount * feePerTransfer;
  const funds = live ? batchFundsNeeded(batch) : run.netIdr + fee;
  const salary = live ? batch.totalIdr : run.netIdr;
  const count = live ? batch.itemCount : run.employeeCount;
  return (
    <aside
      aria-labelledby="payout-selected-title"
      className="grid min-w-0 gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="grid gap-1">
        <p
          id="payout-selected-title"
          className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {t("payrollPayout.runs.selected", {
            period: periodMonthLabel(run.periodStart),
          })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("payrollPayout.runs.receivedBy", { count: formatNumber(count) })}
        </p>
        <Money amount={salary} size="stat" />
      </div>
      <dl className="grid divide-y divide-border text-sm">
        <PanelRow
          label={t("payrollPayout.runs.method")}
          value={t(
            duitkuActive
              ? "payrollPayout.method.duitku"
              : "payrollPayout.method.manual",
          )}
        />
        <PanelRow
          label={t("payrollPayout.runs.source")}
          value={sourceLabel ?? t("payrollPayout.runs.sourceNone")}
        />
        <PanelRow
          label={t(
            live
              ? "payrollPayout.runs.feeActual"
              : "payrollPayout.runs.feeEstimate",
          )}
          money={fee}
        />
        <PanelRow label={t("payrollPayout.runs.funds")} money={funds} strong />
      </dl>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("payrollPayout.runs.feeNote", {
          fee: formatNumber(feePerTransfer),
        })}
      </p>
      <RunAction
        row={row}
        blocked={blocked}
        canRequest={canRequest}
        legalEntityId={legalEntityId}
        onSelectBatch={onSelectBatch}
      />
    </aside>
  );
}

function PanelRow({
  label,
  value,
  money,
  strong = false,
}: {
  label: string;
  value?: string;
  money?: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold" : "font-medium"}>
        {money === undefined ? value : <Money amount={money} size="sm" />}
      </dd>
    </div>
  );
}

function RunsSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayout.common.loading")}
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <div className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}
