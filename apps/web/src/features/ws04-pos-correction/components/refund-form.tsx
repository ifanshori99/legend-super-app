import { useState, type ReactNode } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import type { PosOrderDetail, RefundReason } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Notice,
  StateBlock,
  parseDigits,
} from "../../ws04-pos-kasir/components/shared";
import {
  parseRupiahDigits,
  refundAmountIssue,
  refundableIdr,
} from "../correction-logic";
import { useRefund } from "../hooks";
import { METHOD_LABEL_KEYS, REFUND_REASON_OPTIONS } from "../reason-options";
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
  switcher: ReactNode;
};

// Manual refund of a paid order (POS-02/POS-04). The amount can never pass what
// was paid; the server splits it back over the original payment methods and
// re-checks the limit. Money moves only after a supervisor approves.
export function RefundForm({ order, switcher }: Props) {
  const t = useT();
  const refund = useRefund();
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<RefundReason>("quality_complaint");
  const [touched, setTouched] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refundedNowIdr, setRefundedNowIdr] = useState<number | null>(null);

  const captured = order.tenders.filter(
    (tender) => tender.status === "captured",
  );
  const paidIdr = captured.reduce(
    (sum, tender) => sum + Number(tender.amountIdr),
    0,
  );
  // The order detail carries no refund total (contract gap): earlier refunds are
  // unknown here, so the figure is the paid amount and the API refuses anything
  // above what is still refundable. The screen says so instead of showing Rp0.
  const refundedIdr = 0;
  const availableIdr = refundableIdr({ paidIdr, refundedIdr });
  const methods = [
    ...new Set(
      captured.map((tender) =>
        t(METHOD_LABEL_KEYS[tender.method] ?? "posCorrection.method.cash"),
      ),
    ),
  ].join(", ");

  const amountIdr = parseRupiahDigits(amountText);
  const issue = refundAmountIssue({ amountIdr, availableIdr });
  const noteTooShort = note.trim().length < 4;
  const amountError =
    touched && issue === "empty"
      ? t("posCorrection.refund.amountInvalid")
      : touched && issue === "over"
        ? t("posCorrection.refund.amountOver", {
            available: formatRupiah(availableIdr),
          })
        : undefined;
  const noteError =
    touched && noteTooShort ? t("posCorrection.refund.noteInvalid") : undefined;

  if (order.status !== "completed")
    return (
      <StateBlock
        title={t("posCorrection.refund.notPaidTitle")}
        description={t("posCorrection.refund.notPaidBody")}
      >
        <BackButton />
      </StateBlock>
    );

  if (refundedNowIdr !== null)
    return (
      <StateBlock
        mark="ok"
        title={t("posCorrection.refund.appliedTitle")}
        description={t("posCorrection.refund.appliedBody", {
          amount: formatRupiah(refundedNowIdr),
          orderNo: order.number,
        })}
      >
        <BackButton />
      </StateBlock>
    );

  function handlePrimary() {
    setTouched(true);
    if (issue !== null || noteTooShort) return;
    setDialogOpen(true);
  }

  const submit = (approval: ApprovalSubmit) => {
    if (amountIdr === null || issue !== null) return;
    refund.mutate(
      {
        input: {
          orderId: order.id,
          amountIdr,
          reason,
          reasonNote: note.trim(),
        },
        approval: {
          approverUserId: approval.approverUserId,
          pin: approval.pin,
          reason: approval.reason,
          valueIdr: amountIdr,
          objectType: "order",
          objectId: order.id,
        },
      },
      {
        onSuccess: (result) => {
          // The server may pay less than asked (a promo order); show what it paid.
          setRefundedNowIdr(Number(result.amountIdr));
          setDialogOpen(false);
        },
      },
    );
  };

  const reasonLabel = t(
    REFUND_REASON_OPTIONS.find((option) => option.value === reason)!.labelKey,
  );

  return (
    <>
      <CorrectionLayout
        title={t("posCorrection.title.refund")}
        subtitle={t("posCorrection.subtitle.receipt", {
          receiptNo: order.receipt?.number ?? order.number,
        })}
        badge={
          <HeadingPill>{t("posCorrection.badge.needsApproval")}</HeadingPill>
        }
        switcher={switcher}
        sideTitle={t("posCorrection.summary.source")}
        side={
          <>
            <SummaryLine label={t("posCorrection.summary.receipt")}>
              {order.receipt?.number ?? order.number}
            </SummaryLine>
            <SummaryLine
              label={t("posCorrection.summary.paid", { methods })}
              amountIdr={paidIdr}
            />
            <SummaryLine label={t("posCorrection.summary.refundedBefore")}>
              <span className="text-muted-foreground">
                {t("posCorrection.summary.refundedUnknown")}
              </span>
            </SummaryLine>
            <SummaryDivider />
            <SummaryLine
              label={t("posCorrection.summary.maxByPayment")}
              amountIdr={availableIdr}
              strong
            />
          </>
        }
        panelTitle={t("posCorrection.refund.title")}
        footer={
          <>
            <BackButton />
            <Button type="button" onClick={handlePrimary}>
              {t("posCorrection.actions.requestApproval")}
            </Button>
          </>
        }
      >
        <Notice tone="info" title={t("posCorrection.refund.noticeTitle")}>
          {t("posCorrection.refund.noticeBody")}
        </Notice>
        <Notice tone="warning" title={t("posCorrection.refund.limitTitle")}>
          {t("posCorrection.refund.limitBody")}
        </Notice>
        <FormField
          label={t("posCorrection.refund.amountLabel")}
          hint={
            amountIdr === null
              ? undefined
              : t("posCorrection.refund.amountPreview", {
                  amount: formatRupiah(amountIdr),
                })
          }
          error={amountError}
          required
        >
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={amountText}
            placeholder="0"
            disabled={refund.uncertain}
            onChange={(event) => {
              const digits = parseDigits(event.target.value);
              setAmountText(digits === 0 ? "" : String(digits));
            }}
            onBlur={() => setTouched(true)}
            className="tabular-nums"
          />
        </FormField>
        <ReasonSelect
          label={t("posCorrection.refund.reasonLabel")}
          value={reason}
          onChange={setReason}
          options={REFUND_REASON_OPTIONS}
          disabled={refund.uncertain}
        />
        <FormField
          label={t("posCorrection.refund.noteLabel")}
          error={noteError}
          required
        >
          <Textarea
            rows={2}
            value={note}
            maxLength={500}
            disabled={refund.uncertain}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </FormField>
        <p className="text-sm text-muted-foreground">
          {t("posCorrection.refund.hint")}
        </p>
        {refund.uncertain && (
          <Notice
            tone="danger"
            title={t("posCorrection.refund.uncertainTitle")}
          >
            {t("posCorrection.refund.uncertainBody")}
          </Notice>
        )}
        {refund.isError && !refund.uncertain && !dialogOpen && (
          <Notice
            tone="danger"
            title={t("posCorrection.state.submitErrorTitle")}
          >
            {correctionErrorText(
              refund.error,
              t("posCorrection.state.submitErrorBody"),
            )}
          </Notice>
        )}
      </CorrectionLayout>
      <ApprovalDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) refund.reset();
        }}
        title={t("posCorrection.refund.approvalTitle")}
        summary={
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("posCorrection.refund.approvalSummary", {
                amount: formatRupiah(amountIdr ?? 0),
                orderNo: order.number,
              })}
            </p>
            <p>{reasonLabel}</p>
          </div>
        }
        onSubmit={submit}
        pending={refund.isPending}
        error={
          refund.uncertain
            ? t("posCorrection.refund.uncertainBody")
            : refund.isError
              ? correctionErrorText(
                  refund.error,
                  t("posCorrection.approval.failed"),
                )
              : null
        }
      />
    </>
  );
}
