// Siap bayar: locked runs of the PT that still need paying, with the one next
// step for each (prepare, send for approval, review, see status) and a side
// panel that keeps salary received apart from the PT fee. The server decides
// every step; a disabled or hidden button here is only clarity, and a refusal
// is always shown (docs/briefs/sub-payout-finance-ui.md "Aturan keras").
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Check, CircleAlert, ClipboardList } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type { PayrollDisbursementBatchDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";
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
  isFinalBatch,
  isOpenBatch,
  periodMonthLabel,
  type PayoutTabProps,
} from "../lib";
import { formatDateTime } from "../../ws10-payroll-run/lib";

type RunRow = {
  run: PayableRun;
  /** The batch that blocks a new one (draft to halted); null when none. */
  batch: PayrollDisbursementBatchDto | null;
  /** Newest finished batch (partially failed or completed), if any. */
  lastFinal: PayrollDisbursementBatchDto | null;
};

const newestFirst = (
  a: PayrollDisbursementBatchDto,
  b: PayrollDisbursementBatchDto,
) => b.createdAt.localeCompare(a.createdAt);

/**
 * The newest batch that still blocks a new one for the run. Like the API, a
 * finished batch (completed, partially failed, cancelled) does not: after a
 * partial failure the unpaid slips can be prepared again.
 */
function openBatchOf(batches: readonly PayrollDisbursementBatchDto[]) {
  return (
    [...batches]
      .filter((batch) => isOpenBatch(batch.status))
      .sort(newestFirst)[0] ?? null
  );
}

function lastFinalOf(batches: readonly PayrollDisbursementBatchDto[]) {
  return (
    [...batches]
      .filter(
        (batch) => isFinalBatch(batch.status) && batch.status !== "cancelled",
      )
      .sort(newestFirst)[0] ?? null
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
  const panelRef = React.useRef<HTMLElement | null>(null);

  // Below lg the panel sits under the list: after choosing a run, bring it
  // into view and move focus there so the next step is not off screen.
  const selectRun = (id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
      panel.scrollIntoView({
        block: "start",
        behavior: calm.matches ? "auto" : "smooth",
      });
      panel.focus({ preventScroll: true });
    });
  };

  const rows: RunRow[] = entries.entries.map(({ run, batches }) => ({
    run,
    batch: openBatchOf(batches),
    lastFinal: lastFinalOf(batches),
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
            <ul className="mt-4 grid grid-cols-1 gap-2">
              {rows.map((row) => (
                <RunItem
                  key={row.run.id}
                  row={row}
                  selected={selected?.run.id === row.run.id}
                  onSelectRun={() => selectRun(row.run.id)}
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
              panelRef={panelRef}
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
  onSelectRun,
}: {
  row: RunRow;
  selected: boolean;
  onSelectRun: () => void;
}) {
  const t = useT();
  const names = usePayoutUserNames();
  const { run, batch, lastFinal } = row;
  const shown = batch ?? lastFinal;
  const meta = shown ? batchStatusMeta(shown.status) : null;
  const asker = batch ? (names.get(batch.requestedBy) ?? null) : null;
  const title = t(runTitleKey(run.runType), {
    period: periodMonthLabel(run.periodStart),
  });
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid grid-cols-1 gap-3 rounded-field border-(length:--border-w) p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4",
        selected ? "border-foreground bg-surface-2" : "border-border bg-card",
      )}
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
        <p className="text-lg leading-6 font-semibold">{title}</p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollPayout.runs.employeeCount", {
            count:
              run.employeeCount === null
                ? t("payrollPayout.common.unavailable")
                : formatNumber(run.employeeCount),
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:justify-end">
        <div className="grid sm:text-right">
          {run.netIdr === null ? (
            <span className="text-sm text-muted-foreground">
              {t("payrollPayout.common.unavailable")}
            </span>
          ) : (
            <Money amount={run.netIdr} size="lg" />
          )}
          <span className="text-xs leading-4 text-muted-foreground">
            {t("payrollPayout.runs.netLabel")}
          </span>
        </div>
        <Button
          type="button"
          variant={selected ? "default" : "outline"}
          className="min-h-11 min-w-28"
          onClick={onSelectRun}
        >
          {selected && <Check aria-hidden="true" />}
          {t(
            selected
              ? "payrollPayout.runs.selectedState"
              : "payrollPayout.runs.select",
          )}
          <span className="sr-only"> {title}</span>
        </Button>
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
}: {
  row: RunRow;
  blocked: MessageKey | null;
  canRequest: boolean;
  legalEntityId: string;
  onSelectBatch: PayoutTabProps["onSelectBatch"];
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateBatch(row.run.id);
  const submit = useSubmitBatch();
  const { batch, lastFinal } = row;
  const touch = "min-h-11 w-full";
  const pending = create.isPending || submit.isPending;
  const failure = create.error ?? submit.error;

  let action: React.ReactNode;
  if (batch === null) {
    action = !canRequest ? (
      <p className="text-sm leading-5 text-muted-foreground">
        {t("payrollPayout.runs.needRequestPermission")}
      </p>
    ) : blocked ? (
      <>
        <p className="text-sm leading-5 text-muted-foreground">{t(blocked)}</p>
        <Button asChild variant="outline" className={touch}>
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
        {t(
          lastFinal?.status === "partially_failed"
            ? "payrollPayout.runs.prepareAgain"
            : "payrollPayout.runs.prepare",
        )}
      </Button>
    );
  } else if (batch.status === "draft") {
    action = canRequest ? (
      <Button
        type="button"
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
    <div className="grid gap-2">
      {action}
      {batch === null && lastFinal && (
        <Button
          type="button"
          variant="outline"
          className={touch}
          onClick={() => onSelectBatch(lastFinal.id, lastFinal.status)}
        >
          {t("payrollPayout.runs.seeStatus")}
        </Button>
      )}
      {failure && (
        <p role="alert" className="text-sm leading-5 text-danger">
          {payoutErrorMessage(failure, t)}
        </p>
      )}
    </div>
  );
}

// ---- Side panel -----------------------------------------------------------------

function SelectedPanel({
  panelRef,
  row,
  duitkuActive,
  sourceLabel,
  feePerTransfer,
  canRequest,
  blocked,
  legalEntityId,
  onSelectBatch,
}: {
  panelRef: React.RefObject<HTMLElement | null>;
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
  const { run, batch, lastFinal } = row;
  // The fee is the PT's cost and never comes out of the salary received.
  // Unknown figures stay null and read "Tidak tersedia", never Rp0.
  const figures = panelFigures(run, batch, lastFinal, feePerTransfer);
  const live = batch !== null;
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="payout-selected-title"
      className="grid min-w-0 gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline outline-none"
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
          {figures.count === null
            ? t("payrollPayout.runs.receivedByUnknown")
            : t("payrollPayout.runs.receivedBy", {
                count: formatNumber(figures.count),
              })}
        </p>
        {figures.salary === null ? (
          <p className="text-lg font-semibold">
            {t("payrollPayout.common.unavailable")}
          </p>
        ) : (
          <Money amount={figures.salary} size="stat" />
        )}
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
          money={figures.fee}
        />
        <PanelRow
          label={t("payrollPayout.runs.funds")}
          money={figures.funds}
          strong
        />
      </dl>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("payrollPayout.runs.feeNote", {
          fee: formatNumber(feePerTransfer),
        })}
      </p>
      {!live && lastFinal?.status === "partially_failed" && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollPayout.runs.remainingNote")}
        </p>
      )}
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
  money?: number | null;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold" : "font-medium"}>
        {money === undefined ? (
          value
        ) : money === null ? (
          <UnavailableText />
        ) : (
          <Money amount={money} size="sm" />
        )}
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

function UnavailableText() {
  const t = useT();
  return <>{t("payrollPayout.common.unavailable")}</>;
}

type PanelFigures = {
  count: number | null;
  salary: number | null;
  fee: number | null;
  funds: number | null;
};

/**
 * What the side panel shows. A live batch is exact. Without one, the preview
 * covers only what a bank batch pays: the run's bank-transfer part, not its
 * whole net (cash-paid staff are not in it); after a partial failure it is the
 * failed items. Anything the data does not carry stays null.
 */
function panelFigures(
  run: PayableRun,
  batch: PayrollDisbursementBatchDto | null,
  lastFinal: PayrollDisbursementBatchDto | null,
  feePerTransfer: number,
): PanelFigures {
  if (batch !== null)
    return {
      count: batch.itemCount,
      salary: batch.totalIdr,
      fee: batchFeeTotal(batch),
      funds: batchFundsNeeded(batch),
    };
  if (lastFinal?.status === "partially_failed") {
    const left = lastFinal.items.filter(
      (item) => item.status === "failed" || item.status === "not_sent",
    );
    const salary = left.reduce((sum, item) => sum + item.amountIdr, 0);
    const fee = left.length * feePerTransfer;
    return { count: left.length, salary, fee, funds: salary + fee };
  }
  const count = run.bankEmployeeCount;
  const salary = run.bankTransferIdr;
  const fee = count === null ? null : count * feePerTransfer;
  return {
    count,
    salary,
    fee,
    funds: salary === null || fee === null ? null : salary + fee,
  };
}
