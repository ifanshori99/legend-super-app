// Close a period over parked stock sources (card 1263, founder no. 19): the
// refused close (422 PERIOD_INVENTORY_GL_BLOCKED) names no sources, so this
// section reads them from close-blockers, lists them by item, outlet and day,
// and, when every one is an incomplete production batch and the visitor holds
// the override permission, takes a written reason and closes in two steps.
// The API re-checks everything: the permission, MFA and that `sourceIds` is
// exactly the list still parked.
import * as React from "react";
import { CircleAlert, CircleCheck, Info, ShieldAlert } from "lucide-react";
import type {
  FiscalPeriod,
  PeriodCloseBlockers,
} from "@starter/shared/accounting";
import type { UseQueryResult } from "@tanstack/react-query";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useAttemptKey } from "@/features/ws05-payment-admin/use-attempt-key";
import { ConfirmDialog } from "@/features/ws07-accounting/components/confirm-dialog";
import { useCanOverridePeriodClose } from "@/features/ws07-accounting/guard";
import { ApiError } from "@/lib/api/errors";
import { useClosePeriodOverride } from "../hooks";
import {
  OVERRIDE_REASON_MAX_LENGTH,
  OVERRIDE_REASON_MIN_LENGTH,
  blockerReasonKey,
  blockerSourceKey,
  closeOverrideErrorKey,
  closeOverrideNeedsRefetch,
  formatBusinessDate,
  formatPeriod,
  overrideAttemptPayload,
  overrideMode,
  overrideReasonIssue,
  overrideSourceIds,
} from "../lib";

const STOCK = "accounting.report.periods.closeDialog.stock";

export function PeriodCloseBlocked({
  period,
  legalEntityId,
  blockers,
  onClosed,
}: {
  period: FiscalPeriod;
  legalEntityId: string;
  blockers: UseQueryResult<PeriodCloseBlockers>;
  /** The period is closed: the dialog closes like after a normal close. */
  onClosed: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const canOverride = useCanOverridePeriodClose();
  const override = useClosePeriodOverride(legalEntityId);
  const attempt = useAttemptKey();
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  if (blockers.isPending)
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-14" />
        ))}
      </div>
    );

  if (blockers.isError)
    return (
      <ErrorState
        title={t(`${STOCK}.errorTitle` as const)}
        description={t("state.errorHint")}
        onRetry={() => void blockers.refetch()}
      />
    );

  const data = blockers.data;
  const mode = overrideMode(data, canOverride);
  const sourceIds = overrideSourceIds(data);
  const issue = overrideReasonIssue(reason);
  const trimmedLength = reason.trim().length;
  const issueText =
    issue === "required"
      ? t(`${STOCK}.reasonRequired` as const)
      : issue === "too_short"
        ? t(`${STOCK}.reasonTooShort` as const, {
            min: OVERRIDE_REASON_MIN_LENGTH,
          })
        : issue === "too_long"
          ? t(`${STOCK}.reasonTooLong` as const, {
              max: OVERRIDE_REASON_MAX_LENGTH,
            })
          : undefined;
  const periodLabel = formatPeriod(period.period);

  if (mode === "empty")
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3"
      >
        <CircleCheck
          className="mt-0.5 size-icon shrink-0 text-success"
          aria-hidden="true"
        />
        <div className="grid gap-0.5 text-sm leading-5">
          <p className="font-semibold">{t(`${STOCK}.emptyTitle` as const)}</p>
          <p className="text-muted-foreground">
            {t(`${STOCK}.emptyHint` as const)}
          </p>
        </div>
      </div>
    );

  const submit = async () => {
    const payload = overrideAttemptPayload({
      fiscalPeriodId: period.id,
      expectedVersion: period.version,
      reason,
      sourceIds,
    });
    setNotice(null);
    try {
      await override.mutateAsync({
        ...payload,
        idempotencyKey: attempt.keyFor(payload),
      });
      attempt.settle();
      toast({
        title: t(`${STOCK}.closed` as const, { period: periodLabel }),
        tone: "success",
      });
      setConfirmOpen(false);
      onClosed();
    } catch (error) {
      setConfirmOpen(false);
      const code = error instanceof ApiError ? error.code : "";
      if (closeOverrideNeedsRefetch(code)) {
        // A new list is a new request: it must be confirmed again.
        attempt.settle();
        void blockers.refetch();
      }
      const key = closeOverrideErrorKey(code);
      setNotice(t(key ?? (`${STOCK}.failed` as const)));
    }
  };

  return (
    <section
      aria-labelledby="period-close-blocked-title"
      className="grid gap-3"
    >
      <div
        role="alert"
        className="flex items-start gap-2 rounded-container border-(length:--border-w) border-danger bg-danger-subtle p-3"
      >
        <CircleAlert
          className="mt-0.5 size-icon shrink-0 text-danger"
          aria-hidden="true"
        />
        <div className="grid gap-0.5 text-sm leading-5">
          <p id="period-close-blocked-title" className="font-semibold">
            {t(`${STOCK}.title` as const)}
          </p>
          <p>{t(`${STOCK}.summary` as const)}</p>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <p className="type-eyebrow text-muted-foreground">
          {t(`${STOCK}.listLabel` as const)}
        </p>
        <p className="text-sm font-medium tabular-nums">
          {t(`${STOCK}.count` as const, { count: data.count })}
        </p>
      </div>
      <ul
        aria-label={t(`${STOCK}.listLabel` as const)}
        tabIndex={0}
        className="grid max-h-80 gap-2 overflow-y-auto"
      >
        {data.sources.map((source) => (
          <li
            key={source.sourceId}
            className="grid gap-0.5 rounded-container border-(length:--border-w) border-border p-3 text-sm leading-5"
          >
            <p className="font-medium">
              {source.itemName ?? t(blockerSourceKey(source.sourceType))}
            </p>
            <p className="text-muted-foreground">
              {source.outletName}
              {" · "}
              {source.businessDate
                ? formatBusinessDate(source.businessDate)
                : t(`${STOCK}.unknownDate` as const)}
            </p>
            <p className="text-danger">
              {t(blockerReasonKey(source.errorCode))}
            </p>
          </li>
        ))}
      </ul>

      {notice && (
        <p
          role="alert"
          className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
        >
          {notice}
        </p>
      )}

      {mode === "fix_first" && (
        <div className="flex items-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3 text-sm leading-5">
          <Info
            className="mt-0.5 size-icon shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p>{t(`${STOCK}.fixFirst` as const)}</p>
        </div>
      )}

      {mode === "no_permission" && (
        <div className="flex items-start gap-2 rounded-container border-(length:--border-w) border-border bg-surface-2 p-3 text-sm leading-5">
          <ShieldAlert
            className="mt-0.5 size-icon shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p>{t(`${STOCK}.noPermission` as const)}</p>
        </div>
      )}

      {mode === "allowed" && (
        <div className="grid gap-3 rounded-container border-(length:--border-w) border-border p-3">
          <div className="grid gap-0.5 text-sm leading-5">
            <p className="font-semibold">
              {t(`${STOCK}.overrideTitle` as const)}
            </p>
            <p className="text-muted-foreground">
              {t(`${STOCK}.overrideHint` as const)}
            </p>
          </div>
          <FormField
            label={t(`${STOCK}.reasonLabel` as const)}
            hint={
              <span className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {t(`${STOCK}.reasonHint` as const, {
                    min: OVERRIDE_REASON_MIN_LENGTH,
                  })}
                </span>
                <span className="tabular-nums">
                  {t(`${STOCK}.reasonCounter` as const, {
                    count: trimmedLength,
                    max: OVERRIDE_REASON_MAX_LENGTH,
                  })}
                </span>
              </span>
            }
            error={touched ? issueText : undefined}
            required
          >
            <Textarea
              ref={reasonRef}
              value={reason}
              rows={4}
              maxLength={OVERRIDE_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
            />
          </FormField>
          <Button
            type="button"
            variant="destructive"
            className="w-full sm:w-auto sm:justify-self-end"
            disabled={override.isPending}
            onClick={() => {
              setTouched(true);
              setNotice(null);
              if (issue) {
                reasonRef.current?.focus();
                return;
              }
              setConfirmOpen(true);
            }}
          >
            {t(`${STOCK}.submit` as const)}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t(`${STOCK}.confirmTitle` as const, { period: periodLabel })}
        description={t(`${STOCK}.confirmBody` as const, {
          count: data.sources.length,
        })}
        confirmLabel={t(`${STOCK}.confirmSubmit` as const)}
        pending={override.isPending}
        onConfirm={() => void submit()}
      />
    </section>
  );
}
