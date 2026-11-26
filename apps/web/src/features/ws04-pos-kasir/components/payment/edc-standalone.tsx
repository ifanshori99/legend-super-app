import { useRef, useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/errors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useEdcApprovers,
  useRecordEdcStandalone,
  useRequestEdcApproval,
} from "../../hooks";
import type { EdcMode, EdcTerminal, PaymentBill } from "../../types";
import { Notice, PosPanel, StatusPill } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";
import { edcApprovalKey, edcSlipRefProblem } from "./payment-helpers";
import { INTENT_STORAGE_UNAVAILABLE } from "../../payment-intent-store";

const PIN_LENGTH = 6;
/** Same minimum the record endpoint enforces (mock engine). */
const BANK_REF_MIN_LENGTH = 6;

// Last resort when the ECR link is down and no request is open: copy the bank
// slip and let a supervisor approve with a PIN. The record is marked for
// reconciliation. The supervisor's approval becomes an `overrideId`.
export function EdcStandalone({
  orderId,
  bill,
  terminal,
  mode,
  onBack,
}: {
  orderId: string;
  bill: PaymentBill;
  terminal: EdcTerminal | undefined;
  /** How the customer paid on the machine. */
  mode: EdcMode;
  onBack: () => void;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const supervisors = useEdcApprovers();
  const override = useRequestEdcApproval();
  const record = useRecordEdcStandalone();
  const [bankRef, setBankRef] = useState("");
  // Typed from the paper slip, never taken from the bill: a slip of another
  // amount is not the bill's payment. Locked once the note is written.
  const [slipAmount, setSlipAmount] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [approverId, setApproverId] = useState<string>();
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string>();
  const approvalRef = useRef<{ key: string; overrideId: string } | null>(null);

  const amountIdr = Number(slipAmount);
  // The slip cannot change while it is sent, nor after a note is written for it.
  const slipLocked =
    record.isPending ||
    (record.isError &&
      !(
        record.error instanceof ApiError &&
        record.error.code === INTENT_STORAGE_UNAVAILABLE
      ));
  // Read before any approval: its reason names the reference and is stored.
  const refProblem = bankRef.trim() ? edcSlipRefProblem(bankRef) : undefined;
  // Radix Select can report "" (no matching item yet): treat it as no choice.
  const approver = approverId || undefined;
  const pending = override.isPending || record.isPending;
  const canSubmit =
    terminal !== undefined &&
    amountIdr > 0 &&
    approver !== undefined &&
    bankRef.trim().length >= BANK_REF_MIN_LENGTH &&
    refProblem === undefined &&
    pin.length === PIN_LENGTH &&
    !pending;

  async function submit() {
    if (!canSubmit || !terminal || !approver) return;
    if (edcSlipRefProblem(bankRef) !== undefined) return;
    setPinError(undefined);
    record.reset();
    // An approval the record did not consume is reused for the same order,
    // terminal, amount and slip, so a refused record never costs a second PIN.
    // The supervisor approved this slip: another reference asks again.
    const approvalKey = edcApprovalKey({
      orderId,
      terminalId: terminal.id,
      amountIdr,
      approverId: approver,
      bankRef,
    });
    const kept = approvalRef.current;
    let overrideId: string;
    if (kept && kept.key === approvalKey) {
      overrideId = kept.overrideId;
    } else {
      try {
        const approval = await override.mutateAsync({
          orderId,
          amountIdr,
          reason: t("posKasirEdc.standalone.reason", { ref: bankRef.trim() }),
          approverUserId: approver,
          pin,
        });
        overrideId = approval.overrideId;
        approvalRef.current = { key: approvalKey, overrideId };
      } catch (error) {
        setPin("");
        setPinError(errorText(error));
        return;
      }
    }
    // A refused record shows below; the session updates itself on success.
    await record
      .mutateAsync({
        orderId,
        terminalId: terminal.id,
        amountIdr,
        edcMode: mode,
        bankRef: bankRef.trim(),
        ...(approvalCode.trim() ? { approvalCode: approvalCode.trim() } : {}),
        overrideId,
      })
      .then(() => {
        approvalRef.current = null;
      })
      .catch((error: unknown) => {
        // A spent or mismatched approval cannot be reused: ask for a new PIN.
        const code = error instanceof ApiError ? error.code : undefined;
        if (
          code === "OVERRIDE_USED" ||
          code === "OVERRIDE_INVALID" ||
          code === "EDC_STANDALONE_APPROVAL_REQUIRED"
        ) {
          approvalRef.current = null;
          setPin("");
        }
      });
  }

  return (
    <EdcLayout
      title={t("posKasirEdc.heading.standalone")}
      bill={bill}
      headPill={{ tone: "warning", label: t("posKasirEdc.pill.standalone") }}
      sideLabel={t("posKasirEdc.side.proof")}
      sideAmountIdr={amountIdr > 0 ? amountIdr : bill.remainingIdr}
      sidePill={
        amountIdr === bill.remainingIdr
          ? {
              tone: "neutral",
              label: t("posKasirEdc.side.matchesRemaining"),
            }
          : undefined
      }
      sideTerminal={
        terminal && {
          title: terminal.label,
          detail: `${t(`posKasirEdc.side.mode.${mode}`)} · ${t("posKasirEdc.side.standalone")}`,
        }
      }
      sideNote={t("posKasirEdc.side.standaloneNote")}
    >
      <form
        className="h-full"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PosPanel
          title={t("posKasirEdc.standalone.title")}
          aside={
            <StatusPill tone="neutral">
              {t("posKasirEdc.standalone.pill")}
            </StatusPill>
          }
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onBack}
                disabled={pending}
              >
                {t("posKasirEdc.standalone.back")}
              </Button>
              <Button type="submit" disabled={!canSubmit} loading={pending}>
                {t("posKasirEdc.standalone.submit")}
              </Button>
            </>
          }
        >
          <div className="grid gap-4">
            <Notice
              tone="warning"
              title={t("posKasirEdc.standalone.noticeTitle")}
            >
              {t("posKasirEdc.standalone.noticeBody")}
            </Notice>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                label={t("posKasirPayment.unresolved.slipAmount")}
                hint={
                  amountIdr > 0
                    ? formatRupiah(amountIdr)
                    : t("posKasirPayment.unresolved.slipAmountHint")
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
                  readOnly={slipLocked}
                />
              </FormField>
              <FormField
                label={t("posKasirEdc.standalone.bankRef")}
                hint={t("posKasirEdc.standalone.bankRefHint")}
                error={refProblem}
                required
              >
                <Input
                  name="bankRef"
                  value={bankRef}
                  onChange={(event) => setBankRef(event.target.value)}
                  readOnly={slipLocked}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                />
              </FormField>
              <FormField
                label={t("posKasirEdc.standalone.supervisor")}
                hint={t("posKasirEdc.standalone.pinHint")}
                required
              >
                <Select
                  value={approver ?? ""}
                  onValueChange={(next) => setApproverId(next || undefined)}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t(
                        "posKasirEdc.standalone.supervisorPlaceholder",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(supervisors.data ?? []).map((item) => (
                      <SelectItem key={item.userId} value={item.userId}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={t("posKasirEdc.standalone.approval")}>
                <Input
                  name="approvalCode"
                  value={approvalCode}
                  onChange={(event) => setApprovalCode(event.target.value)}
                  readOnly={slipLocked}
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                />
              </FormField>
              <FormField
                label={t("posKasirEdc.standalone.pin")}
                error={pinError}
                required
              >
                <Input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={PIN_LENGTH}
                  value={pin}
                  onChange={(event) => {
                    setPin(event.target.value.replace(/\D/g, ""));
                    if (pinError) setPinError(undefined);
                  }}
                  className="tabular"
                />
              </FormField>
            </div>
            {(supervisors.isError || supervisors.data?.length === 0) && (
              <Notice
                tone="warning"
                title={t("posKasirEdc.standalone.noApprover")}
              >
                {t("posKasirEdc.standalone.noApproverHint")}
              </Notice>
            )}
            {record.error && (
              <Notice
                tone="danger"
                title={t("posKasirEdc.standalone.recordError")}
              >
                {errorText(record.error)}
              </Notice>
            )}
            <p className="text-base text-muted-foreground">
              {t("posKasirEdc.standalone.confirm", {
                amount: formatRupiah(amountIdr),
              })}
            </p>
          </div>
        </PosPanel>
      </form>
    </EdcLayout>
  );
}
