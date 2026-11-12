import { useState, type ReactNode } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import type { DiscountReason, PosOrderDetail } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Notice, StateBlock } from "../../ws04-pos-kasir/components/shared";
import {
  discountNeedsApproval,
  discountPreview,
  parsePercentBp,
  percentDiscountIdr,
  taxRateBpsOf,
} from "../correction-logic";
import { useApplyDiscount, useCorrectionPolicy } from "../hooks";
import { DISCOUNT_REASON_OPTIONS } from "../reason-options";
import { ApprovalDialog, type ApprovalSubmit } from "./approval-dialog";
import {
  BackButton,
  CorrectionLayout,
  HeadingPill,
  ReasonSelect,
  SummaryDivider,
  SummaryLine,
  correctionErrorText,
} from "./parts";

type Props = {
  order: PosOrderDetail;
  subtitle: string;
  switcher: ReactNode;
  onOpenRefund: () => void;
};

// Manual discount (POS-02). The cashier picks a percent; the server works out
// the amount from the subtotal, so the screen shows the same figure first. Above
// the outlet's threshold a supervisor approves with a PIN; the bill changes
// only when the server accepts it.
export function DiscountForm({
  order,
  subtitle,
  switcher,
  onOpenRefund,
}: Props) {
  const t = useT();
  const policy = useCorrectionPolicy();
  const apply = useApplyDiscount();
  const [percentText, setPercentText] = useState("");
  const [touched, setTouched] = useState(false);
  const [reason, setReason] = useState<DiscountReason>("complaint_recovery");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [appliedIdr, setAppliedIdr] = useState<number | null>(null);

  const subtotalIdr = Number(order.subtotalIdr);
  const percentBp = parsePercentBp(percentText);
  const proposedIdr =
    percentBp === null ? 0 : percentDiscountIdr({ subtotalIdr, percentBp });
  // The server checks against what the order already carries: every live
  // discount against the subtotal, and the manual ones plus this one against
  // the approval threshold.
  const existingIdr = order.discounts.reduce(
    (sum, line) => sum + Number(line.amountIdr),
    0,
  );
  const existingManualIdr = order.discounts
    .filter((line) => line.source === "manual")
    .reduce((sum, line) => sum + Number(line.amountIdr), 0);
  const exceeds = existingIdr + proposedIdr > subtotalIdr;
  const preview = discountPreview({
    subtotalIdr,
    discountIdr: existingIdr + proposedIdr,
    taxRateBps: taxRateBpsOf({
      taxIdr: Number(order.taxIdr),
      baseIdr: Math.max(subtotalIdr - existingIdr, 0),
    }),
  });
  // Until the outlet's threshold is known the discount is treated as needing
  // approval (the safe side); the server decides in any case.
  const thresholdBp = policy.data?.discountThresholdBp;
  const needsApproval =
    thresholdBp === undefined || subtotalIdr === 0
      ? true
      : discountNeedsApproval({
          subtotalIdr,
          discountIdr: existingManualIdr + proposedIdr,
          thresholdBp,
        });
  const reasonLabel = t(
    DISCOUNT_REASON_OPTIONS.find((option) => option.value === reason)!.labelKey,
  );
  const valid = percentBp !== null && proposedIdr > 0 && !exceeds;
  const percentError = !touched
    ? undefined
    : percentBp === null
      ? t("posCorrection.discount.percentInvalid")
      : proposedIdr <= 0
        ? t("posCorrection.discount.tooSmall")
        : exceeds
          ? t("posCorrection.discount.exceeds")
          : undefined;

  function submit(approval?: ApprovalSubmit) {
    if (percentBp === null || !valid) return;
    apply.mutate(
      {
        input: {
          orderId: order.id,
          percentBp,
          reason,
          reasonNote: approval?.reason ?? reasonLabel,
          expectedVersion: order.version,
        },
        ...(approval
          ? {
              approval: {
                approverUserId: approval.approverUserId,
                pin: approval.pin,
                reason: approval.reason,
                valueIdr: proposedIdr,
                objectType: "order" as const,
                objectId: order.id,
              },
            }
          : {}),
      },
      {
        onSuccess: () => {
          setAppliedIdr(proposedIdr);
          setDialogOpen(false);
        },
      },
    );
  }

  function handlePrimary() {
    setTouched(true);
    if (!valid) return;
    if (needsApproval) setDialogOpen(true);
    else submit();
  }

  // A discount only goes on an order that is not settled (the server refuses
  // otherwise); a paid order is corrected by refund.
  if (order.status === "completed" || order.status === "voided")
    return (
      <StateBlock
        title={t("posCorrection.discount.lockedTitle")}
        description={t("posCorrection.discount.lockedBody")}
      >
        <div className="flex flex-wrap justify-center gap-3">
          <BackButton />
          {order.status === "completed" && (
            <Button type="button" onClick={onOpenRefund}>
              {t("posCorrection.void.goRefund")}
            </Button>
          )}
        </div>
      </StateBlock>
    );

  if (appliedIdr !== null)
    return (
      <StateBlock
        mark="ok"
        title={t("posCorrection.discount.appliedTitle")}
        description={t("posCorrection.discount.appliedBody", {
          amount: formatRupiah(appliedIdr),
          orderNo: order.number,
        })}
      >
        <BackButton />
      </StateBlock>
    );

  return (
    <>
      <CorrectionLayout
        title={t("posCorrection.title.diskon")}
        subtitle={subtitle}
        badge={
          needsApproval && (
            <HeadingPill>{t("posCorrection.badge.needsApproval")}</HeadingPill>
          )
        }
        switcher={switcher}
        sideTitle={t("posCorrection.summary.order", { orderNo: order.number })}
        side={
          <>
            <SummaryLine
              label={t("posCorrection.summary.subtotal")}
              amountIdr={subtotalIdr}
            />
            {existingIdr > 0 && (
              <SummaryLine
                label={t("posCorrection.summary.discountExisting")}
                amountIdr={-existingIdr}
              />
            )}
            <SummaryLine
              label={t("posCorrection.summary.discountProposed")}
              amountIdr={proposedIdr === 0 ? 0 : -proposedIdr}
            />
            <SummaryLine
              label={t("posCorrection.summary.tax")}
              amountIdr={preview.taxIdr}
            />
            <SummaryDivider />
            <SummaryLine
              label={t("posCorrection.summary.totalAfterDiscount")}
              amountIdr={preview.totalIdr}
              strong
            />
            <p className="text-sm text-muted-foreground">
              {t("posCorrection.summary.discountNote")}
            </p>
          </>
        }
        panelTitle={t("posCorrection.discount.title")}
        footer={
          <>
            <BackButton />
            <Button
              type="button"
              loading={apply.isPending && !needsApproval}
              onClick={handlePrimary}
            >
              {t(
                needsApproval
                  ? "posCorrection.actions.requestApproval"
                  : "posCorrection.actions.applyDiscount",
              )}
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground">
          {t("posCorrection.discount.hint")}
        </p>
        <FormField
          label={t("posCorrection.discount.percentLabel")}
          hint={t("posCorrection.discount.percentHint")}
          error={percentError}
          required
        >
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={percentText}
            placeholder={t("posCorrection.discount.percentPlaceholder")}
            onChange={(event) => setPercentText(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </FormField>
        <FormField label={t("posCorrection.discount.amountLabel")}>
          <Input
            readOnly
            value={formatRupiah(proposedIdr)}
            className="tabular-nums"
          />
        </FormField>
        <ReasonSelect
          label={t("posCorrection.discount.reasonLabel")}
          value={reason}
          onChange={setReason}
          options={DISCOUNT_REASON_OPTIONS}
        />
        {needsApproval ? (
          <Notice
            tone="warning"
            title={t("posCorrection.discount.pendingTitle")}
          >
            {t("posCorrection.discount.pendingBody")}
          </Notice>
        ) : (
          <Notice tone="info" title={t("posCorrection.discount.belowTitle")}>
            {t("posCorrection.discount.belowBody")}
          </Notice>
        )}
        {apply.isError && !dialogOpen && (
          <Notice
            tone="danger"
            title={t("posCorrection.state.submitErrorTitle")}
          >
            {correctionErrorText(
              apply.error,
              t("posCorrection.state.submitErrorBody"),
            )}
          </Notice>
        )}
      </CorrectionLayout>
      <ApprovalDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) apply.reset();
        }}
        title={t("posCorrection.discount.approvalTitle")}
        summary={
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("posCorrection.discount.approvalSummary", {
                amount: formatRupiah(proposedIdr),
                orderNo: order.number,
              })}
            </p>
            <p>
              {t("posCorrection.discount.approvalReason", {
                reason: reasonLabel,
              })}
            </p>
          </div>
        }
        onSubmit={submit}
        pending={apply.isPending}
        error={
          apply.isError
            ? correctionErrorText(
                apply.error,
                t("posCorrection.approval.failed"),
              )
            : null
        }
      />
    </>
  );
}
