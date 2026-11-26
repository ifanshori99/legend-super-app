import { useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/errors";
import { useRecordEdcStandalone } from "../../hooks";
import type { EdcMode, EdcTerminal, PaymentBill } from "../../types";
import { Notice, PosPanel, StatusPill } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";
import { edcSlipRefProblem } from "./payment-helpers";
import { INTENT_STORAGE_UNAVAILABLE } from "../../payment-intent-store";

/** "148.000": the slip amount as the slip prints it. */
const formatThousands = (value: number) =>
  new Intl.NumberFormat("id-ID").format(value);

/** Same minimum the record endpoint enforces (6-24, never a card number). */
const BANK_REF_MIN_LENGTH = 6;

// Manual EDC (X1, cloud-only release §3): the customer pays on the bank's own
// machine and the cashier copies the slip. No supervisor PIN: the slip
// reference is required and the payment is matched to the bank statement on
// the H+1 reconciliation, like Moka, Majoo and Pawoon do.
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
  const record = useRecordEdcStandalone();
  const [bankRef, setBankRef] = useState("");
  // Typed from the paper slip, never taken from the bill: a slip of another
  // amount is not the bill's payment. Locked once the note is written.
  const [slipAmount, setSlipAmount] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [refTouched, setRefTouched] = useState(false);
  const [amountTouched, setAmountTouched] = useState(false);

  const amountIdr = Number(slipAmount);
  // Strictest rule (CTO, review C3b P3): a slip that is not the remaining bill
  // is never sent, so a typo cannot lock the bill as an unknown payment.
  const mismatch = amountIdr > 0 && amountIdr !== bill.remainingIdr;
  const amountProblem = mismatch
    ? t("posKasirEdc.standalone.amountMismatch", {
        remaining: formatRupiah(bill.remainingIdr),
      })
    : amountTouched && amountIdr <= 0
      ? t("posKasirEdc.standalone.amountRequired")
      : undefined;
  // The slip cannot change while it is sent, nor after a note is written for it.
  const slipLocked =
    record.isPending ||
    (record.isError &&
      !(
        record.error instanceof ApiError &&
        record.error.code === INTENT_STORAGE_UNAVAILABLE
      ));
  const trimmedRef = bankRef.trim();
  const refProblem = trimmedRef
    ? edcSlipRefProblem(bankRef)
    : refTouched
      ? t("posKasirEdc.standalone.bankRefRequired")
      : undefined;
  const canSubmit =
    terminal !== undefined &&
    amountIdr > 0 &&
    !mismatch &&
    trimmedRef.length >= BANK_REF_MIN_LENGTH &&
    edcSlipRefProblem(bankRef) === undefined &&
    !record.isPending;

  function submit() {
    setRefTouched(true);
    setAmountTouched(true);
    if (!canSubmit || !terminal) return;
    record.reset();
    // A refused record shows below; the session updates itself on success.
    record.mutate({
      orderId,
      terminalId: terminal.id,
      amountIdr,
      edcMode: mode,
      bankRef: trimmedRef,
      ...(approvalCode.trim() ? { approvalCode: approvalCode.trim() } : {}),
    });
  }

  return (
    <EdcLayout
      title={t("posKasirEdc.heading.standalone")}
      bill={bill}
      headPill={{ tone: "warning", label: t("posKasirEdc.pill.standalone") }}
      sideLabel={t("posKasirEdc.side.proof")}
      sideAmountIdr={amountIdr > 0 ? amountIdr : null}
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
          submit();
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
                disabled={record.isPending}
                className="w-full sm:w-auto"
              >
                {t("posKasirEdc.standalone.back")}
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                loading={record.isPending}
                className="w-full sm:w-auto"
              >
                {t(
                  record.isPending
                    ? "posKasirEdc.standalone.submitting"
                    : "posKasirEdc.standalone.submit",
                )}
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
                hint={t("posKasirPayment.unresolved.slipAmountHint")}
                error={amountProblem}
                required
              >
                <Input
                  name="slipAmount"
                  value={amountIdr > 0 ? formatThousands(amountIdr) : ""}
                  onChange={(event) =>
                    setSlipAmount(
                      event.target.value.replace(/\D/g, "").slice(0, 12),
                    )
                  }
                  onBlur={() => setAmountTouched(true)}
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
                  onBlur={() => setRefTouched(true)}
                  readOnly={slipLocked}
                  maxLength={24}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                />
              </FormField>
              <FormField label={t("posKasirEdc.standalone.approval")}>
                <Input
                  name="approvalCode"
                  value={approvalCode}
                  onChange={(event) => setApprovalCode(event.target.value)}
                  readOnly={slipLocked}
                  maxLength={12}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                />
              </FormField>
            </div>
            {record.error && (
              <Notice
                tone="danger"
                title={t("posKasirEdc.standalone.recordError")}
              >
                {errorText(record.error)}
              </Notice>
            )}
            {amountIdr > 0 && !mismatch && (
              <p className="text-base text-muted-foreground">
                {t("posKasirEdc.standalone.confirm", {
                  amount: formatRupiah(amountIdr),
                })}
              </p>
            )}
          </div>
        </PosPanel>
      </form>
    </EdcLayout>
  );
}
