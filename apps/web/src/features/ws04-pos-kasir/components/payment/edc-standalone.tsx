import { useState } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useRecordEdcStandalone,
  useRequestOverride,
  useSupervisorOptions,
} from "../../hooks";
import type { EdcTerminal, PaymentBill } from "../../types";
import { Notice, PosPanel, StatusPill } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";

const PIN_LENGTH = 6;

// Last resort when the ECR link is down and no request is open: copy the bank
// slip and let a supervisor approve with a PIN. The record is marked for
// reconciliation. The supervisor's approval becomes an `overrideId`.
export function EdcStandalone({
  orderId,
  bill,
  terminal,
  onBack,
}: {
  orderId: string;
  bill: PaymentBill;
  terminal: EdcTerminal | undefined;
  onBack: () => void;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const supervisors = useSupervisorOptions();
  const override = useRequestOverride();
  const record = useRecordEdcStandalone();
  const [bankRef, setBankRef] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [approverId, setApproverId] = useState<string>();
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string>();

  const amountIdr = bill.remainingIdr;
  const approver = approverId ?? supervisors.data?.[0]?.userId;
  const pending = override.isPending || record.isPending;
  const canSubmit =
    terminal !== undefined &&
    approver !== undefined &&
    bankRef.trim() !== "" &&
    pin.length === PIN_LENGTH &&
    !pending;

  async function submit() {
    if (!canSubmit || !terminal || !approver) return;
    setPinError(undefined);
    record.reset();
    let overrideId: string;
    try {
      const approval = await override.mutateAsync({
        action: "edc_standalone",
        valueIdr: amountIdr,
        reason: t("posKasirEdc.standalone.reason", { ref: bankRef.trim() }),
        objectType: "pos_order",
        objectId: orderId,
        approverUserId: approver,
        pin,
      });
      overrideId = approval.overrideId;
    } catch (error) {
      setPin("");
      setPinError(errorText(error));
      return;
    }
    // A refused record shows below; the session updates itself on success.
    await record
      .mutateAsync({
        orderId,
        terminalId: terminal.id,
        bankRef: bankRef.trim(),
        ...(approvalCode.trim() ? { approvalCode: approvalCode.trim() } : {}),
        overrideId,
      })
      .catch(() => undefined);
  }

  return (
    <EdcLayout
      title={t("posKasirEdc.heading.standalone")}
      bill={bill}
      headPill={{ tone: "warning", label: t("posKasirEdc.pill.standalone") }}
      sideLabel={t("posKasirEdc.side.proof")}
      sideAmountIdr={amountIdr}
      sidePill={{
        tone: "neutral",
        label: t("posKasirEdc.side.matchesRemaining"),
      }}
      sideTerminal={
        terminal && {
          title: terminal.label,
          detail: `${t("posKasirEdc.side.mode.card")} · ${t("posKasirEdc.side.standalone")}`,
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
                label={t("posKasirEdc.standalone.bankRef")}
                hint={t("posKasirEdc.standalone.bankRefHint")}
                required
              >
                <Input
                  value={bankRef}
                  onChange={(event) => setBankRef(event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  className="tabular"
                />
              </FormField>
              <FormField
                label={t("posKasirEdc.standalone.supervisor")}
                hint={t("posKasirEdc.standalone.pinHint")}
                required
              >
                <Select value={approver ?? ""} onValueChange={setApproverId}>
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
                  value={approvalCode}
                  onChange={(event) => setApprovalCode(event.target.value)}
                  autoComplete="off"
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
