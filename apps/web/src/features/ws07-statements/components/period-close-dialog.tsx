// Close checklist (ACC-02): contract preconditions, unposted journals and the
// trial-balance check, then a confirm step that states posting is refused
// afterwards. The checklist blockers are the bead's close guard; the contract
// rules come from closeReadiness (decidePeriodClose).
import * as React from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  type LucideIcon,
} from "lucide-react";
import type { FiscalPeriod } from "@starter/shared/accounting";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/features/ws07-accounting/components/confirm-dialog";
import { ApiError } from "@/lib/api/errors";
import {
  blockingJournalCounts,
  businessDateToday,
  closeReadiness,
  formatBusinessDate,
  formatPeriod,
  periodBounds,
} from "../lib";
import {
  useCloseManualJournals,
  useClosePeriod,
  usePeriodCloseBlockers,
  useTrialBalance,
} from "../hooks";
import { PeriodCloseBlocked } from "./period-close-override";

type CheckState = "ok" | "blocked" | "info";

type ChecklistItem = {
  key: MessageKey;
  state: CheckState;
  detail: string;
};

const CHECK_ICONS: Record<CheckState, { icon: LucideIcon; tone: string }> = {
  ok: { icon: CircleCheck, tone: "text-success" },
  blocked: { icon: CircleAlert, tone: "text-danger" },
  info: { icon: CircleDashed, tone: "text-muted-foreground" },
};

export function PeriodCloseDialog({
  open,
  onOpenChange,
  legalEntityId,
  period,
  entityPeriods,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  period: FiscalPeriod | null;
  entityPeriods: readonly FiscalPeriod[];
}) {
  const t = useT();
  const toast = useToast();
  const today = businessDateToday();
  const periodEnd = period ? periodBounds(period.period).end : "1970-01-01";
  const trial = useTrialBalance(
    legalEntityId,
    periodEnd,
    open && period !== null,
  );
  const journals = useCloseManualJournals(
    legalEntityId,
    open && period !== null,
  );
  const close = useClosePeriod(legalEntityId);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  // Card 1263: the period whose close was refused for parked stock sources.
  const [blockedPeriodId, setBlockedPeriodId] = React.useState<string | null>(
    null,
  );
  const showBlocked = period !== null && blockedPeriodId === period.id;
  const blockers = usePeriodCloseBlockers(period?.id, open && showBlocked);
  // While sources are parked the plain close would only be refused again.
  const closeHeldBySources =
    showBlocked &&
    (blockers.isPending || (blockers.data?.sources.length ?? 0) > 0);
  // With the list on screen the section below owns the only close button.
  const hidePlainClose =
    showBlocked && (blockers.data?.sources.length ?? 0) > 0;
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setBlockedPeriodId(null);
      setServerError(null);
    }
    onOpenChange(next);
  };

  const loading = trial.isPending || journals.isPending;
  const failed = trial.isError || journals.isError;
  const counts = blockingJournalCounts(
    journals.data?.data ?? [],
    period?.period ?? "1970-01",
  );
  const balanced = trial.data
    ? trial.data.totalDebitIdr === trial.data.totalCreditIdr
    : true;
  const readiness = period
    ? closeReadiness({
        period,
        entityPeriods,
        today,
        draftCount: counts.draft,
        pendingCount: counts.pending,
        trialBalanceBalanced: balanced,
      })
    : { blockers: [], ready: false };

  const blocked = (code: string) =>
    readiness.blockers.some((blocker) => blocker.code === code);

  const checklist: ChecklistItem[] = [
    {
      key: "accounting.report.periods.closeDialog.checkPeriodEnded",
      state: blocked("PERIOD_NOT_ENDED") ? "blocked" : "ok",
      detail: blocked("PERIOD_NOT_ENDED")
        ? t("accounting.report.periods.closeDialog.notEndedHint")
        : t("accounting.report.periods.closeDialog.detailOk"),
    },
    {
      key: "accounting.report.periods.closeDialog.checkPreviousClosed",
      state: blocked("PERIOD_CLOSE_OUT_OF_ORDER") ? "blocked" : "ok",
      detail: blocked("PERIOD_CLOSE_OUT_OF_ORDER")
        ? t("accounting.report.periods.closeDialog.previousOpenHint")
        : t("accounting.report.periods.closeDialog.detailOk"),
    },
    {
      key: "accounting.report.periods.closeDialog.checkNoDraft",
      state: counts.draft > 0 ? "blocked" : "ok",
      detail:
        counts.draft > 0
          ? `${t("accounting.report.periods.closeDialog.draftBlocked", {
              count: counts.draft,
            })}. ${t("accounting.report.periods.closeDialog.draftHint")}`
          : t("accounting.report.periods.closeDialog.detailOk"),
    },
    {
      key: "accounting.report.periods.closeDialog.checkNoPending",
      state: counts.pending > 0 ? "blocked" : "ok",
      detail:
        counts.pending > 0
          ? `${t("accounting.report.periods.closeDialog.pendingBlocked", {
              count: counts.pending,
            })}. ${t("accounting.report.periods.closeDialog.pendingHint")}`
          : t("accounting.report.periods.closeDialog.detailOk"),
    },
    {
      key: "accounting.report.periods.closeDialog.checkBalanced",
      state: balanced ? "ok" : "blocked",
      detail: balanced
        ? t("accounting.report.periods.closeDialog.detailOk")
        : t("accounting.report.periods.closeDialog.unbalancedHint"),
    },
    {
      key: "accounting.report.periods.closeDialog.checkSnapshot",
      state: "info",
      detail: t("accounting.report.periods.closeDialog.snapshotPending"),
    },
  ];

  const submit = async () => {
    if (!period) return;
    setServerError(null);
    try {
      await close.mutateAsync({
        fiscalPeriodId: period.id,
        expectedVersion: period.version,
      });
      toast({
        title: t("accounting.report.periods.closeDialog.closed", {
          period: formatPeriod(period.period),
        }),
        tone: "success",
      });
      setConfirmOpen(false);
      handleOpenChange(false);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "PERIOD_INVENTORY_GL_BLOCKED"
      ) {
        // The refusal names no sources; the section below reads them.
        setBlockedPeriodId(period.id);
        setConfirmOpen(false);
        return;
      }
      setServerError(
        error instanceof ApiError
          ? error.message
          : t("accounting.report.periods.closeDialog.failed"),
      );
      setConfirmOpen(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t("accounting.report.periods.closeDialog.title", {
                period: period ? formatPeriod(period.period) : "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("accounting.report.periods.closeDialog.description")}
            </DialogDescription>
          </DialogHeader>

          {/* Only the body scrolls: the header and the buttons stay whole. */}
          <div
            role="region"
            aria-label={t("accounting.report.periods.closeDialog.checklist")}
            tabIndex={0}
            className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {loading && (
              <div className="grid gap-2" aria-busy="true">
                <span className="sr-only">{t("common.loading")}</span>
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-14" />
                ))}
              </div>
            )}

            {!loading && failed && (
              <ErrorState
                title={t("accounting.report.periods.closeDialog.errorTitle")}
                description={t("state.errorHint")}
                onRetry={() => {
                  void trial.refetch();
                  void journals.refetch();
                }}
              />
            )}

            {!loading && !failed && period && (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <p className="type-eyebrow text-muted-foreground">
                    {t("accounting.report.periods.closeDialog.checklist")}
                  </p>
                  <ul className="grid gap-2">
                    {checklist.map((item) => {
                      const { icon: Icon, tone } = CHECK_ICONS[item.state];
                      return (
                        <li
                          key={item.key}
                          className="flex items-start gap-2 rounded-container border-(length:--border-w) border-border p-3"
                        >
                          <Icon
                            className={`mt-0.5 size-icon shrink-0 ${tone}`}
                            aria-hidden="true"
                          />
                          <div className="grid gap-0.5 text-sm leading-5">
                            <p className="font-medium">{t(item.key)}</p>
                            <p
                              className={
                                item.state === "blocked"
                                  ? "text-danger"
                                  : "text-muted-foreground"
                              }
                            >
                              {item.detail}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {trial.data && (
                  <dl className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3 sm:grid-cols-2">
                    <div className="grid gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("accounting.report.periods.closeDialog.totalDebit")}
                      </dt>
                      <dd>
                        <Money amount={trial.data.totalDebitIdr} />
                      </dd>
                    </div>
                    <div className="grid gap-0.5">
                      <dt className="type-eyebrow text-muted-foreground">
                        {t("accounting.report.periods.closeDialog.totalCredit")}
                      </dt>
                      <dd>
                        <Money amount={trial.data.totalCreditIdr} />
                      </dd>
                    </div>
                    <p className="text-sm text-muted-foreground sm:col-span-2">
                      {t("accounting.report.periods.closeDialog.totals", {
                        date: formatBusinessDate(periodEnd),
                      })}
                    </p>
                  </dl>
                )}

                {showBlocked ? (
                  <PeriodCloseBlocked
                    key={period.id}
                    period={period}
                    legalEntityId={legalEntityId}
                    blockers={blockers}
                    onClosed={() => handleOpenChange(false)}
                  />
                ) : readiness.ready ? (
                  <div className="flex items-start gap-2 rounded-container border-(length:--border-w) border-success bg-success-subtle p-3">
                    <CircleCheck
                      className="mt-0.5 size-icon shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <div className="grid gap-0.5 text-sm leading-5">
                      <p className="font-semibold">
                        {t("accounting.report.periods.closeDialog.readyTitle")}
                      </p>
                      <p className="text-muted-foreground">
                        {t("accounting.report.periods.closeDialog.readyHint")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p role="alert" className="text-sm font-medium text-danger">
                    {t("accounting.report.periods.closeDialog.blockersTitle")}
                  </p>
                )}

                {serverError && (
                  <p
                    role="alert"
                    className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
                  >
                    {serverError}
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="mt-0 shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={close.isPending}
            >
              {t("common.cancel")}
            </Button>
            {!hidePlainClose && (
              <Button
                type="button"
                disabled={
                  !readiness.ready ||
                  close.isPending ||
                  loading ||
                  failed ||
                  closeHeldBySources
                }
                loading={close.isPending}
                onClick={() => {
                  setServerError(null);
                  setConfirmOpen(true);
                }}
              >
                {t("accounting.report.periods.closeDialog.submit")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("accounting.report.periods.closeDialog.confirmTitle", {
          period: period ? formatPeriod(period.period) : "",
        })}
        description={t("accounting.report.periods.closeDialog.confirmBody")}
        confirmLabel={t("accounting.report.periods.closeDialog.confirmSubmit")}
        pending={close.isPending}
        onConfirm={() => void submit()}
      />
    </>
  );
}
