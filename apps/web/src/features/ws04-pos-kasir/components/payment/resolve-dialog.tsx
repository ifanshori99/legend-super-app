import { useState } from "react";
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
import { useResolveApprovers, type useResolvePayment } from "../../hooks";
import type { ResolvePaymentInput } from "../../types";
import { Notice, SupervisorPinDialog } from "../shared";
import { EMPTY_SLIP, SlipFields, slipInput } from "./resolve-slip-fields";

const VOID_REF_MIN_LENGTH = 4;

// A supervisor settles a payment request without a known answer (1268 W2): who
// approves, what they state about the card (an EDC or unreadable request), a
// reason and their own PIN. The server decides; nothing opens before it answers.
// A charged card is recorded with the slip of the stored request as it is; only
// when that cannot be read is the paper slip typed, also to find it on a bill
// that is already paid.
export function ResolveDialog({
  orderId,
  kind,
  slip,
  paid = false,
  resolve,
  open,
  onOpenChange,
}: {
  orderId: string;
  kind: "edc" | "corrupt" | "other";
  /** The stored slip, shown to the supervisor; it cannot be changed. */
  slip: { amountIdr: number; bankRef: string } | null;
  /** A paid bill takes no other payment. */
  paid?: boolean;
  /** Owned by the screen: its answer outlives this dialog. */
  resolve: ReturnType<typeof useResolvePayment>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const approvers = useResolveApprovers(
    kind === "other" ? "void" : "edc_standalone",
    open,
  );
  const [pickedId, setPickedId] = useState<string>();
  const [card, setCard] = useState<ResolvePaymentInput["card"]>();
  const [voidRef, setVoidRef] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [typed, setTyped] = useState(EMPTY_SLIP);
  const [formError, setFormError] = useState<string | null>(null);

  const options = approvers.data ?? [];
  const approverUserId = (
    options.find((option) => option.userId === pickedId) ?? options[0]
  )?.userId;
  const needsCard = kind !== "other";

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={(next) => {
        // Stay open while the server decides.
        if (!next && resolve.isPending) return;
        setFormError(null);
        setCard(undefined);
        setVoidRef("");
        setBankRef("");
        setTyped(EMPTY_SLIP);
        resolve.reset();
        onOpenChange(next);
      }}
      title={t("posKasirPayment.unresolved.resolveTitle")}
      summary={t("posKasirPayment.unresolved.resolveSummary")}
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
              disabled={resolve.isPending}
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
          {needsCard && (
            <FormField
              label={t("posKasirPayment.unresolved.cardLabel")}
              hint={t(
                paid
                  ? "posKasirPayment.unresolved.cardPaidHint"
                  : "posKasirPayment.unresolved.cardHint",
              )}
              required
            >
              <Select
                value={card ?? ""}
                onValueChange={(next) => {
                  setCard((next || undefined) as ResolvePaymentInput["card"]);
                  setFormError(null);
                }}
                disabled={resolve.isPending}
              >
                <SelectTrigger className="h-control">
                  <SelectValue
                    placeholder={t(
                      "posKasirPayment.unresolved.cardPlaceholder",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_debited">
                    {t("posKasirPayment.unresolved.cardNotDebited")}
                  </SelectItem>
                  {(!paid || kind === "corrupt") && (
                    <SelectItem value="recording">
                      {t(
                        paid
                          ? "posKasirPayment.unresolved.cardRecorded"
                          : "posKasirPayment.unresolved.cardRecording",
                      )}
                    </SelectItem>
                  )}
                  <SelectItem value="voided">
                    {t("posKasirPayment.unresolved.cardVoided")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
          {slip && (
            <p className="text-base text-muted-foreground">
              {t("posKasirPayment.unresolved.slip", {
                amount: formatRupiah(slip.amountIdr),
                ref: slip.bankRef,
              })}
            </p>
          )}
          {card === "voided" && kind === "corrupt" && (
            <FormField
              label={t("posKasirEdc.standalone.bankRef")}
              hint={t("posKasirEdc.standalone.bankRefHint")}
              required
            >
              <Input
                name="bankRef"
                value={bankRef}
                onChange={(event) => setBankRef(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="tabular"
                disabled={resolve.isPending}
              />
            </FormField>
          )}
          {card === "voided" && (
            <FormField
              label={t("posKasirPayment.unresolved.voidRef")}
              hint={t("posKasirPayment.unresolved.voidRefHint")}
              required
            >
              <Input
                name="voidRef"
                value={voidRef}
                onChange={(event) => setVoidRef(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="tabular"
                disabled={resolve.isPending}
              />
            </FormField>
          )}
          {card === "recording" && kind === "corrupt" && (
            <SlipFields
              value={typed}
              onChange={setTyped}
              disabled={resolve.isPending}
            />
          )}
        </div>
      }
      onSubmit={({ reason, pin }) => {
        if (resolve.isPending) return;
        if (!approverUserId)
          return setFormError(
            t("posCorrection.approval.supervisorPlaceholder"),
          );
        if (needsCard && !card)
          return setFormError(t("posKasirPayment.unresolved.cardRequired"));
        const voided = voidRef.trim();
        if (card === "voided" && voided.length < VOID_REF_MIN_LENGTH)
          return setFormError(t("posKasirPayment.unresolved.voidRefRequired"));
        const ref = bankRef.trim();
        if (card === "voided" && kind === "corrupt" && !ref)
          return setFormError(t("posKasirEdc.standalone.bankRefRequired"));
        const charged =
          card === "recording" && kind === "corrupt" ? slipInput(typed) : null;
        if (card === "recording" && kind === "corrupt" && !charged)
          return setFormError(t("posKasirPayment.unresolved.slipRequired"));
        setFormError(null);
        resolve.mutate(
          {
            orderId,
            reason,
            approverUserId,
            pin,
            ...(needsCard ? { card } : {}),
            ...(card === "voided" ? { voidRef: voided } : {}),
            ...(card === "voided" && kind === "corrupt"
              ? { bankRef: ref }
              : {}),
            ...(charged ? { slip: charged } : {}),
          },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
      pending={resolve.isPending}
      error={formError ?? resolve.error?.message ?? null}
      minReasonLength={4}
    />
  );
}
