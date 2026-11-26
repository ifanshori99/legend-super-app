// A supervisor settles a cash or card attempt of the charge whose answer never
// reached the till (legend-f1mmf (d), 1268 W2 pattern): who approves, what the
// terminal showed for a card whose answer is unknown (not charged, or charged
// with the slip), a reason and their own PIN. The server decides; the charge
// stays locked until it answers. Nothing here books an amount: the slip's
// printed amount is evidence the server compares with the charge.
import { useState } from "react";
import {
  ISSUE_CHARGE_EDC_STATEMENT_REQUIRED,
  ISSUE_CHARGE_SLIP_REQUIRED,
  type PosIssueChargeAttemptOutcome,
} from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/errors";
import {
  Notice,
  SupervisorPinDialog,
} from "@/features/ws04-pos-kasir/components/shared";
import { useResolveApprovers } from "@/features/ws04-pos-kasir/hooks";
import { useResolveChargeAttempt } from "../charge-hooks";

export type ResolvableAttempt = {
  method: "cash" | "edc";
  key: string;
  /** The card's answer is unknown on the server: the statement is needed. */
  needsStatement: boolean;
};

type Statement = "failed" | "paid";

const SLIP_CODE = /^[A-Za-z0-9]{1,24}$/;
const APPROVAL_CODE = /^[A-Za-z0-9]{1,12}$/;

export function ChargeResolveDialog({
  chargeId,
  amountIdr,
  attempt,
  open,
  onOpenChange,
  onSettled,
}: {
  chargeId: string;
  amountIdr: number;
  attempt: ResolvableAttempt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettled: (outcome: PosIssueChargeAttemptOutcome, key: string) => void;
}) {
  const t = useT();
  const resolve = useResolveChargeAttempt(chargeId);
  const approvers = useResolveApprovers(
    attempt.method === "cash" ? "void" : "edc_standalone",
    open,
  );
  const [pickedId, setPickedId] = useState<string>();
  const [statement, setStatement] = useState<Statement>();
  const [rrn, setRrn] = useState("");
  const [approval, setApproval] = useState("");
  const [slipAmount, setSlipAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const options = approvers.data ?? [];
  const approverUserId = (
    options.find((option) => option.userId === pickedId) ?? options[0]
  )?.userId;
  const serverCode =
    resolve.error instanceof ApiError ? resolve.error.code : null;
  // The server asks for the statement when the card's answer is unknown.
  const askStatement =
    attempt.method === "edc" &&
    (attempt.needsStatement ||
      serverCode === ISSUE_CHARGE_EDC_STATEMENT_REQUIRED ||
      serverCode === ISSUE_CHARGE_SLIP_REQUIRED);
  const serverError =
    serverCode === ISSUE_CHARGE_EDC_STATEMENT_REQUIRED
      ? t("posIssueCharge.resolve.statementRequired")
      : serverCode === ISSUE_CHARGE_SLIP_REQUIRED
        ? t("posIssueCharge.resolve.slipRequired")
        : (resolve.error?.message ?? null);
  const amount = formatRupiah(amountIdr);
  const busy = resolve.isPending;

  const reset = () => {
    setFormError(null);
    setStatement(undefined);
    setRrn("");
    setApproval("");
    setSlipAmount("");
    resolve.reset();
  };

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={(next) => {
        // Stay open while the server decides.
        if (!next && busy) return;
        reset();
        onOpenChange(next);
      }}
      title={t("posIssueCharge.resolve.title")}
      summary={t(
        attempt.method === "cash"
          ? "posIssueCharge.resolve.summaryCash"
          : "posIssueCharge.resolve.summaryEdc",
        { amount },
      )}
      details={
        <div className="grid gap-3">
          {(approvers.isError || approvers.data?.length === 0) && (
            <Notice
              tone="warning"
              title={t(
                approvers.isError
                  ? "posCorrection.approval.supervisorsError"
                  : "posCorrection.approval.supervisorsEmpty",
              )}
            />
          )}
          <FormField
            label={t("posCorrection.approval.supervisorLabel")}
            hint={t("posCorrection.approval.supervisorHint")}
            required
          >
            <Select
              value={approverUserId ?? ""}
              onValueChange={(next) => setPickedId(next || undefined)}
              disabled={busy}
            >
              <SelectTrigger className="h-control">
                <SelectValue
                  placeholder={t(
                    "posCorrection.approval.supervisorPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.userId} value={option.userId}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {askStatement && (
            <FormField
              label={t("posIssueCharge.resolve.statementLabel")}
              hint={t("posIssueCharge.resolve.statementHint")}
              required
            >
              <Select
                value={statement ?? ""}
                onValueChange={(next) => {
                  setStatement((next || undefined) as Statement | undefined);
                  setFormError(null);
                }}
                disabled={busy}
              >
                <SelectTrigger className="h-control">
                  <SelectValue
                    placeholder={t(
                      "posIssueCharge.resolve.statementPlaceholder",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="failed">
                    {t("posIssueCharge.resolve.statementFailed")}
                  </SelectItem>
                  <SelectItem value="paid">
                    {t("posIssueCharge.resolve.statementPaid")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
          {askStatement && statement === "paid" && (
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label={t("posIssueCharge.resolve.slipRrn")} required>
                <Input
                  name="slipRrn"
                  value={rrn}
                  onChange={(event) => setRrn(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                  disabled={busy}
                />
              </FormField>
              <FormField
                label={t("posIssueCharge.resolve.slipApproval")}
                required
              >
                <Input
                  name="slipApprovalCode"
                  value={approval}
                  onChange={(event) => setApproval(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                  disabled={busy}
                />
              </FormField>
              <FormField
                label={t("posIssueCharge.resolve.slipAmount")}
                hint={
                  slipAmount
                    ? formatRupiah(Number(slipAmount))
                    : t("posIssueCharge.resolve.slipAmountHint")
                }
                required
              >
                <Input
                  name="slipAmount"
                  value={slipAmount}
                  onChange={(event) =>
                    setSlipAmount(
                      event.target.value.replace(/\D/g, "").slice(0, 12),
                    )
                  }
                  inputMode="numeric"
                  autoComplete="off"
                  className="tabular"
                  disabled={busy}
                />
              </FormField>
            </div>
          )}
        </div>
      }
      onSubmit={({ reason, pin }) => {
        if (busy) return;
        if (!approverUserId)
          return setFormError(
            t("posCorrection.approval.supervisorPlaceholder"),
          );
        if (askStatement && !statement)
          return setFormError(t("posIssueCharge.resolve.statementRequired"));
        const slip =
          askStatement && statement === "paid"
            ? {
                rrn: rrn.trim(),
                approvalCode: approval.trim(),
                chargedAmountIdr: Number(slipAmount),
              }
            : null;
        if (
          slip &&
          (!SLIP_CODE.test(slip.rrn) ||
            !APPROVAL_CODE.test(slip.approvalCode) ||
            !(slip.chargedAmountIdr > 0))
        )
          return setFormError(t("posIssueCharge.resolve.slipRequired"));
        setFormError(null);
        resolve.mutate(
          {
            method: attempt.method,
            idempotencyKey: attempt.key,
            ...(askStatement && statement ? { edc: statement } : {}),
            ...(slip ? { slip } : {}),
            reason,
            approverUserId,
            pin,
          },
          {
            onSuccess: (answer) => {
              onSettled(answer.outcome, attempt.key);
              reset();
              onOpenChange(false);
            },
          },
        );
      }}
      pending={busy}
      error={formError ?? serverError}
      minReasonLength={3}
    />
  );
}
