import { useState, type ReactNode } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import type { PosOrderDetail, VoidReason } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Notice, StateBlock } from "../../ws04-pos-kasir/components/shared";
import { subtotalAfterVoidIdr } from "../correction-logic";
import { useVoidItem } from "../hooks";
import { VOID_REASON_OPTIONS } from "../reason-options";
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
  /** The line the order detail screen sent the cashier here for. */
  itemId?: string;
  subtitle: string;
  switcher: ReactNode;
  onOpenRefund: () => void;
};

// Void one line of an order that is not settled yet (POS-02). A line already
// sent to the kitchen shows a warning to check the kitchen first. The bill
// keeps the line until a supervisor approves and the server accepts the void.
export function VoidForm({
  order,
  itemId,
  subtitle,
  switcher,
  onOpenRefund,
}: Props) {
  const t = useT();
  const voidItem = useVoidItem();
  const [reason, setReason] = useState<VoidReason>("customer_cancelled");
  const [pickedId, setPickedId] = useState<string | undefined>(itemId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (order.status === "completed")
    return (
      <StateBlock
        title={t("posCorrection.void.finalTitle")}
        description={t("posCorrection.void.finalBody")}
      >
        <div className="flex flex-wrap justify-center gap-3">
          <BackButton />
          <Button type="button" onClick={onOpenRefund}>
            {t("posCorrection.void.goRefund")}
          </Button>
        </div>
      </StateBlock>
    );

  const voidable = order.items.filter((item) => item.status !== "voided");
  const item =
    voidable.find((candidate) => candidate.id === pickedId) ?? voidable[0];

  if (done !== null)
    return (
      <StateBlock
        mark="ok"
        title={t("posCorrection.void.appliedTitle")}
        description={t("posCorrection.void.appliedBody", {
          item: done,
          orderNo: order.number,
        })}
      >
        <BackButton />
      </StateBlock>
    );

  if (!item)
    return (
      <StateBlock
        title={t("posCorrection.void.noItemsTitle")}
        description={t("posCorrection.void.noItemsBody")}
      >
        <BackButton />
      </StateBlock>
    );

  const sent = item.fireStatus === "fired";
  const itemIdr = Number(item.lineTotalIdr);
  const subtotalIdr = Number(order.subtotalIdr);
  const itemLabel = t("posCorrection.void.itemLine", {
    quantity: item.quantity,
    name: item.name,
  });
  const reasonLabel = t(
    VOID_REASON_OPTIONS.find((option) => option.value === reason)!.labelKey,
  );

  const submit = (approval: ApprovalSubmit) => {
    voidItem.mutate(
      {
        input: {
          orderId: order.id,
          itemId: item.id,
          reason,
          reasonNote: approval.reason,
          expectedVersion: order.version,
        },
        approval: {
          approverUserId: approval.approverUserId,
          pin: approval.pin,
          reason: approval.reason,
          valueIdr: itemIdr,
          objectType: "order_item",
          objectId: item.id,
        },
      },
      {
        onSuccess: () => {
          setDone(itemLabel);
          setDialogOpen(false);
        },
      },
    );
  };

  return (
    <>
      <CorrectionLayout
        title={t("posCorrection.title.void")}
        subtitle={subtitle}
        badge={
          <HeadingPill>
            {t(
              sent
                ? "posCorrection.badge.sentToKitchen"
                : "posCorrection.badge.needsApproval",
            )}
          </HeadingPill>
        }
        switcher={switcher}
        sideTitle={t("posCorrection.summary.order", { orderNo: order.number })}
        side={
          <>
            <SummaryLine
              label={t("posCorrection.summary.subtotalBeforeVoid")}
              amountIdr={subtotalIdr}
            />
            <SummaryLine
              label={t("posCorrection.summary.itemProposed")}
              amountIdr={itemIdr === 0 ? 0 : -itemIdr}
            />
            <SummaryDivider />
            <SummaryLine
              label={t("posCorrection.summary.subtotalAfterVoid")}
              amountIdr={subtotalAfterVoidIdr({ subtotalIdr, itemIdr })}
              strong
            />
            <p className="text-sm text-muted-foreground">
              {t("posCorrection.summary.voidNote")}
            </p>
          </>
        }
        panelTitle={t("posCorrection.void.title")}
        footer={
          <>
            <BackButton />
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t("posCorrection.actions.requestApproval")}
            </Button>
          </>
        }
      >
        {voidable.length > 1 && (
          <FormField label={t("posCorrection.void.itemLabel")} required>
            <Select value={item.id} onValueChange={setPickedId}>
              <SelectTrigger className="h-control">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voidable.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {t("posCorrection.void.itemLine", {
                      quantity: candidate.quantity,
                      name: candidate.name,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">{itemLabel}</p>
            <p className="text-sm text-muted-foreground">
              {t(
                sent ? "posCorrection.void.sent" : "posCorrection.void.notSent",
              )}
            </p>
          </div>
          <Money amount={itemIdr} className="font-semibold" />
        </div>
        <ReasonSelect
          label={t("posCorrection.void.reasonLabel")}
          value={reason}
          onChange={setReason}
          options={VOID_REASON_OPTIONS}
        />
        <Notice
          tone="warning"
          title={t(
            sent
              ? "posCorrection.void.noticeAfterTitle"
              : "posCorrection.void.noticeBeforeTitle",
          )}
        >
          {t(
            sent
              ? "posCorrection.void.noticeAfterBody"
              : "posCorrection.void.noticeBeforeBody",
          )}
        </Notice>
        {voidItem.isError && !dialogOpen && (
          <Notice
            tone="danger"
            title={t("posCorrection.state.submitErrorTitle")}
          >
            {correctionErrorText(
              voidItem.error,
              t("posCorrection.state.submitErrorBody"),
            )}
          </Notice>
        )}
      </CorrectionLayout>
      <ApprovalDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) voidItem.reset();
        }}
        title={t("posCorrection.void.approvalTitle")}
        summary={
          <div className="grid gap-1">
            <p className="font-semibold">
              {t("posCorrection.void.approvalSummary", {
                item: itemLabel,
                orderNo: order.number,
              })}
            </p>
            <p>
              {formatRupiah(itemIdr)} · {reasonLabel}
            </p>
          </div>
        }
        onSubmit={submit}
        pending={voidItem.isPending}
        error={
          voidItem.isError
            ? correctionErrorText(
                voidItem.error,
                t("posCorrection.approval.failed"),
              )
            : null
        }
      />
    </>
  );
}
