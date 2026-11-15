// Confirmation step of an EDC reconciliation (bead legend-khi8n). Shows what
// will be decided, makes the reviewer tick that the evidence was checked, then
// sends the decision. The server answers MFA_REQUIRED / REAUTH_REQUIRED when
// the session has no fresh MFA: the step-up panel is shown inside this dialog
// and the same request is repeated. Any other refusal stays here and the form
// behind the dialog keeps its values. Resolving never books a payment; the
// cashier's ECR tender stays the only record, and the copy says so.
import * as React from "react";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import {
  useStepUp,
  VerifyPanel,
} from "@/features/ws10-payroll-payout/components/approval-verify";
import type { MessageKey } from "@starter/shared/i18n";
import {
  resolveEdcReconciliationBodySchema,
  type EdcReconciliationEvidenceSource,
  type EdcReconciliationOutcome,
  type ResolveEdcReconciliationBody,
} from "@starter/shared/edc";
import {
  listEdcReconciliationQueue,
  type EdcReconciliationQueueItem,
} from "@starter/shared/payment/admin";
import { useResolveEdcReconciliation } from "../hooks";
import { displayId } from "../lib";

const P = "edcRecon.resolve";
const key = (suffix: string) => `${P}.${suffix}` as MessageKey;

/** What the form collected, already validated by the form. */
export type ResolveDraft = {
  outcome: EdcReconciliationOutcome;
  source: EdcReconciliationEvidenceSource;
  /** Amount printed on the evidence; only used for approved. */
  chargedAmountIdr: number | null;
  approvalCode: string;
  rrn: string;
  note: string;
};

export const SOURCE_KEYS: Record<EdcReconciliationEvidenceSource, string> = {
  inquiry: "form.sourceInquiry",
  terminal_receipt: "form.sourceTerminalReceipt",
  bank_statement: "form.sourceBankStatement",
};

export function buildResolveBody(
  draft: ResolveDraft,
): ResolveEdcReconciliationBody {
  const approvalCode = draft.approvalCode.trim();
  const rrn = draft.rrn.trim();
  // Parsed by the shared schema (not cast) so the amount is a branded Idr.
  return resolveEdcReconciliationBodySchema.parse({
    outcome: draft.outcome,
    evidence: {
      source: draft.source,
      note: draft.note.trim(),
      ...(approvalCode ? { approvalCode } : {}),
      ...(rrn ? { rrn } : {}),
      ...(draft.outcome === "approved" && draft.chargedAmountIdr !== null
        ? { chargedAmountIdr: draft.chargedAmountIdr }
        : {}),
    },
  });
}

/** The API sends the amount refusal as a plain CONFLICT with this sentence. */
const AMOUNT_MISMATCH_MESSAGE =
  "Nominal di terminal EDC tidak sama dengan tagihan";

type Refusal = {
  key: MessageKey;
  message?: string;
  /** The queue may have moved on: offer to reload it. */
  stale?: boolean;
};

function refusalKey(error: unknown): Refusal {
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "NETWORK_ERROR")
      return { key: key("error.network"), stale: true };
    if (
      error.code === "EDC_AMOUNT_MISMATCH" ||
      (error.code === "CONFLICT" &&
        error.message.includes(AMOUNT_MISMATCH_MESSAGE))
    )
      return { key: key("error.amountMismatch"), stale: true };
    if (error.status === 403 || error.code === "FORBIDDEN")
      return { key: key("error.forbidden") };
    if (error.status === 409 || error.code === "CONFLICT")
      return {
        key: key("error.conflict"),
        message: error.message,
        stale: true,
      };
  }
  return { key: key("error.generic") };
}

export function ConfirmDialog({
  item,
  draft,
  open,
  onOpenChange,
  onResolved,
}: {
  item: EdcReconciliationQueueItem;
  draft: ResolveDraft;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: (result: {
    id: string;
    outcome: EdcReconciliationOutcome;
  }) => void;
}) {
  const t = useT();
  const resolve = useResolveEdcReconciliation();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const checkId = React.useId();
  const tx = item.transaction;
  const outcomeWord = t(key(`outcomeWord.${draft.outcome}`));

  const reloadQueue = () =>
    queryClient.invalidateQueries({
      queryKey: [listEdcReconciliationQueue.id],
    });

  // A dialog opened again starts unchecked and without the last refusal, so
  // closing clears them (in the handler, not an effect on `open`).
  const changeOpen = (next: boolean) => {
    if (!next) {
      setConfirmed(false);
      setError(null);
      setStale(false);
      stepUp.reset();
    }
    onOpenChange(next);
  };

  const reloadAndClose = async () => {
    setReloading(true);
    try {
      await reloadQueue();
    } finally {
      setReloading(false);
    }
    changeOpen(false);
  };

  const send = async () => {
    if (resolve.isPending) return;
    setError(null);
    setStale(false);
    try {
      await resolve.mutateAsync({
        id: tx.id,
        body: buildResolveBody(draft),
      });
      stepUp.reset();
      setDone(true);
    } catch (caught) {
      if (stepUp.capture(caught)) return;
      stepUp.reset();
      const refusal = refusalKey(caught);
      setError(t(refusal.key, { message: refusal.message ?? "" }));
      if (refusal.stale) {
        setStale(true);
        void reloadQueue();
      }
    }
  };

  const finish = () => {
    changeOpen(false);
    onResolved({ id: displayId(tx), outcome: draft.outcome });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (resolve.isPending) return;
        if (!next && done) {
          finish();
          return;
        }
        changeOpen(next);
      }}
    >
      <DialogContent
        data-testid="edc-recon-dialog"
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>{t(key("dialog.title"))}</DialogTitle>
              <DialogDescription className="sr-only">
                {t(key("dialog.description"))}
              </DialogDescription>
            </DialogHeader>
            <div
              role="status"
              aria-live="polite"
              data-testid="edc-recon-success"
              className="grid gap-1 rounded-container border-(length:--border-w) border-success bg-success-subtle p-3 text-sm text-foreground"
            >
              <p className="flex items-center gap-2 font-semibold">
                <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
                {t(key("success.title"))} · {displayId(tx)}
              </p>
              <p>{t(key("success.body"))}</p>
            </div>
            <DialogFooter>
              <Button type="button" className="min-h-11" onClick={finish}>
                {t(key("dialog.done"))}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t(key("dialog.title"))}</DialogTitle>
              <DialogDescription>
                {t(key("dialog.description"))}
              </DialogDescription>
            </DialogHeader>

            <section
              aria-label={t(key("dialog.summaryHeading"))}
              className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm"
            >
              <p className="font-semibold">
                {displayId(tx)} · {item.outletName}
              </p>
              <p className="flex flex-wrap items-center gap-x-2">
                <Money amount={tx.amountIdr} size="sm" />
                {item.billNumber && <span>· {item.billNumber}</span>}
              </p>
              <p className="mt-1">
                {t(key("dialog.result"))}:{" "}
                <strong data-testid="edc-recon-dialog-outcome">
                  {outcomeWord}
                </strong>
              </p>
              <p className="text-muted-foreground">
                {t(key("dialog.evidence"))}:{" "}
                {t(key("dialog.evidenceLine"), {
                  source: t(key(SOURCE_KEYS[draft.source])),
                  trace: tx.trace || t(key("receipt.missing")),
                })}
              </p>
              {draft.outcome === "approved" &&
                draft.chargedAmountIdr !== null && (
                  <p className="text-muted-foreground">
                    {t(key("dialog.chargedAmount"))}:{" "}
                    <Money amount={draft.chargedAmountIdr} size="sm" />
                  </p>
                )}
            </section>

            <p className="flex items-start gap-2 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t(key("dialog.notice"))}
            </p>

            <label
              htmlFor={checkId}
              className="flex min-h-11 items-start gap-3 py-2"
            >
              <Checkbox
                id={checkId}
                checked={confirmed}
                disabled={resolve.isPending}
                onCheckedChange={(next) => setConfirmed(next === true)}
              />
              <span className="text-sm leading-5 font-medium">
                {t(key("dialog.confirmCheck"))}
              </span>
            </label>

            {stepUp.active && (
              <VerifyPanel
                key={stepUp.round}
                copy={{
                  title: t(key("verify.title")),
                  mfaHint: t(key("verify.mfaHint")),
                }}
                needs={stepUp.needs}
                busy={resolve.isPending}
                error={error}
                onVerified={() => void send()}
                onCancel={() => stepUp.reset()}
              />
            )}

            {error && !stepUp.active && (
              <p
                role="alert"
                data-testid="edc-recon-dialog-error"
                className="flex items-start gap-2 text-sm font-medium text-danger"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {error}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={resolve.isPending}
                onClick={() => changeOpen(false)}
              >
                {t(key("dialog.back"))}
              </Button>
              {stale && !stepUp.active && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  loading={reloading}
                  onClick={() => void reloadAndClose()}
                  data-testid="edc-recon-dialog-reload"
                >
                  {t(key("dialog.reload"))}
                </Button>
              )}
              {!stepUp.active && (
                <Button
                  type="button"
                  className="min-h-11"
                  loading={resolve.isPending}
                  disabled={!confirmed}
                  onClick={() => void send()}
                >
                  {t(
                    key(
                      draft.outcome === "approved"
                        ? "dialog.submitApproved"
                        : "dialog.submitDeclined",
                    ),
                  )}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
