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
import { useActorId } from "@/features/ws04-pos-kasir/hooks";
import { useChargeApprovers, useResolveChargeAttempt } from "../charge-hooks";
import { CollectDeadlineError } from "../charge-method-logic";

export type ResolvableAttempt = {
  method: "cash" | "edc";
  key: string;
  /** The card's answer is unknown on the server: the statement is needed. */
  needsStatement: boolean;
};

type Statement = "failed" | "paid";

const SLIP_CODE = /^[A-Za-z0-9]{1,24}$/;
const APPROVAL_CODE = /^[A-Za-z0-9]{1,12}$/;

type Field = "approver" | "statement" | "rrn" | "approval" | "amount";

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
  // The caller is never offered: the server refuses them as approver.
  const approvers = useChargeApprovers(
    attempt.method === "cash" ? "void" : "edc_standalone",
    useActorId(),
    open,
  );
  const [pickedId, setPickedId] = useState<string>();
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [statement, setStatement] = useState<Statement>();
  const [rrn, setRrn] = useState("");
  const [approval, setApproval] = useState("");
  const [slipAmount, setSlipAmount] = useState("");

  const options = approvers.data ?? [];
  // No approver is chosen for the supervisor: they pick themselves.
  const approverUserId = options.find(
    (option) => option.userId === pickedId,
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
    resolve.error instanceof CollectDeadlineError
      ? t("posIssueCharge.resolve.timeout")
      : serverCode === ISSUE_CHARGE_EDC_STATEMENT_REQUIRED
        ? t("posIssueCharge.resolve.statementRequired")
        : serverCode === ISSUE_CHARGE_SLIP_REQUIRED
          ? t("posIssueCharge.resolve.slipRequired")
          : (resolve.error?.message ?? null);
  const slipShown = askStatement && statement === "paid";
  // Each field says what is wrong next to it (on leaving it, and on the PIN),
  // and a field error never empties the PIN.
  const problems: Partial<Record<Field, string>> = {};
  if (!approverUserId)
    problems.approver = t("posIssueCharge.resolve.approverRequired");
  if (askStatement && !statement)
    problems.statement = t("posIssueCharge.resolve.statementRequired");
  if (slipShown && !SLIP_CODE.test(rrn.trim()))
    problems.rrn = t("posIssueCharge.resolve.rrnInvalid");
  if (slipShown && !APPROVAL_CODE.test(approval.trim()))
    problems.approval = t("posIssueCharge.resolve.approvalInvalid");
  if (slipShown && !(Number(slipAmount) > 0))
    problems.amount = t("posIssueCharge.resolve.amountInvalid");
  const shown = (field: Field) =>
    touched.has(field) ? problems[field] : undefined;
  const touch = (field: Field) =>
    setTouched((current) => new Set(current).add(field));
  const amount = formatRupiah(amountIdr);
  const busy = resolve.isPending;

  const reset = () => {
    setPickedId(undefined);
    setTouched(new Set());
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
        // Closing while the server decides keeps the request going; the
        // screen reads the server again (the settle replays with its key).
        if (!busy) reset();
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
              title={
                approvers.isError
                  ? t("posCorrection.approval.supervisorsError")
                  : t("posIssueCharge.resolve.approversNone")
              }
            />
          )}
          <FormField
            label={t("posCorrection.approval.supervisorLabel")}
            hint={t("posCorrection.approval.supervisorHint")}
            error={shown("approver")}
            required
          >
            <Select
              value={approverUserId ?? ""}
              onValueChange={(next) => {
                setPickedId(next || undefined);
                touch("approver");
              }}
              disabled={busy}
            >
              <SelectTrigger
                className="h-control"
                onBlur={() => touch("approver")}
              >
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
              error={shown("statement")}
              required
            >
              <Select
                value={statement ?? ""}
                onValueChange={(next) => {
                  setStatement((next || undefined) as Statement | undefined);
                  touch("statement");
                }}
                disabled={busy}
              >
                <SelectTrigger
                  className="h-control"
                  onBlur={() => touch("statement")}
                >
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
          {slipShown && (
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                label={t("posIssueCharge.resolve.slipRrn")}
                error={shown("rrn")}
                required
              >
                <Input
                  name="slipRrn"
                  value={rrn}
                  onChange={(event) => setRrn(event.target.value)}
                  onBlur={() => touch("rrn")}
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                  disabled={busy}
                />
              </FormField>
              <FormField
                label={t("posIssueCharge.resolve.slipApproval")}
                error={shown("approval")}
                required
              >
                <Input
                  name="slipApprovalCode"
                  value={approval}
                  onChange={(event) => setApproval(event.target.value)}
                  onBlur={() => touch("approval")}
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
                error={shown("amount")}
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
                  onBlur={() => touch("amount")}
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
        const missing = Object.keys(problems) as Field[];
        if (missing.length > 0) {
          setTouched(new Set(missing));
          return;
        }
        if (!approverUserId) return;
        const slip = slipShown
          ? {
              rrn: rrn.trim(),
              approvalCode: approval.trim(),
              chargedAmountIdr: Number(slipAmount),
            }
          : null;
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
      error={serverError}
      minReasonLength={3}
    />
  );
}
