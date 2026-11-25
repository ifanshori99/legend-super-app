import { useState } from "react";
import { useT } from "@/components/i18n";
import { FormField } from "@/components/ui/form-field";
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

// A supervisor settles a payment request without a known answer (1268 W2): who
// approves, what they state about the card (an EDC or unreadable request), a
// reason and their own PIN. The server decides; nothing opens before it answers.
export function ResolveDialog({
  orderId,
  kind,
  resolve,
  open,
  onOpenChange,
}: {
  orderId: string;
  kind: "edc" | "corrupt" | "other";
  /** Owned by the screen: its answer outlives this dialog. */
  resolve: ReturnType<typeof useResolvePayment>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const approvers = useResolveApprovers(
    kind === "edc" ? "edc_standalone" : "void",
    open,
  );
  const [pickedId, setPickedId] = useState<string>();
  const [card, setCard] = useState<ResolvePaymentInput["card"]>();
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
                kind === "corrupt"
                  ? "posKasirPayment.unresolved.cardCorruptHint"
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
                  {kind === "edc" && (
                    <SelectItem value="recording">
                      {t("posKasirPayment.unresolved.cardRecording")}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </FormField>
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
        setFormError(null);
        resolve.mutate(
          {
            orderId,
            reason,
            approverUserId,
            pin,
            ...(needsCard ? { card } : {}),
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
