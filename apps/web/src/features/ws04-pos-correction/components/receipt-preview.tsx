import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import type { PosOrderDetail, ReceiptDocument } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import { Notice, StateBlock } from "../../ws04-pos-kasir/components/shared";
import { usePrintReceipt, useReceiptDocument } from "../hooks";
import { METHOD_LABEL_KEYS } from "../reason-options";
import { BackButton, CorrectionLayout, correctionErrorText } from "./parts";

type Props = {
  order: PosOrderDetail;
  subtitle: string;
  switcher: ReactNode;
};

function PaperRow({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? "flex justify-between gap-3 font-bold"
          : "flex justify-between gap-3"
      }
    >
      <span className="min-w-0">{label}</span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function PaperRule() {
  return (
    <div
      role="presentation"
      className="border-t-(length:--border-w) border-dashed border-border"
    />
  );
}

// The printed receipt as a snapshot: amounts are the ones on the document, never
// recomputed here (POS-07).
function ReceiptPaper({ document }: { document: ReceiptDocument }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const issued = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(document.issuedAt));
  const discountIdr = Number(document.discountIdr);
  const serviceIdr = Number(document.serviceChargeIdr);
  const taxIdr = Number(document.taxIdr);
  const roundingIdr = Number(document.roundingIdr);
  return (
    <article
      aria-label={t("posCorrection.receipt.previewTitle")}
      className="mx-auto grid w-full max-w-[29rem] gap-3 rounded-container border-(length:--border-w) border-dashed border-border bg-card p-card text-(length:--density-text)"
    >
      <header className="grid gap-1 text-center">
        <p className="font-bold">{document.outletName}</p>
        <p className="text-sm text-muted-foreground">
          {document.outletAddress}
        </p>
        <p className="tabular text-sm text-muted-foreground">
          {document.receiptNumber} · {issued}
        </p>
        {document.reprint && (
          <p className="text-sm font-semibold">
            {t("posCorrection.receipt.reprintMark")}
          </p>
        )}
      </header>
      <PaperRule />
      {document.items.map((item, index) => (
        <PaperRow
          key={`${item.name}-${index}`}
          label={t("posCorrection.receipt.itemLine", {
            quantity: item.quantity,
            name: item.name,
          })}
        >
          <Money amount={Number(item.lineTotalIdr)} className="font-semibold" />
        </PaperRow>
      ))}
      <PaperRule />
      <PaperRow label={t("posCorrection.receipt.subtotal")}>
        <Money
          amount={Number(document.subtotalIdr)}
          className="font-semibold"
        />
      </PaperRow>
      {discountIdr > 0 && (
        <PaperRow label={t("posCorrection.receipt.discount")}>
          <Money amount={-discountIdr} className="font-semibold" />
        </PaperRow>
      )}
      {serviceIdr > 0 && (
        <PaperRow label={t("posCorrection.receipt.service")}>
          <Money amount={serviceIdr} className="font-semibold" />
        </PaperRow>
      )}
      {taxIdr > 0 && (
        <PaperRow label={t("posCorrection.receipt.tax")}>
          <Money amount={taxIdr} className="font-semibold" />
        </PaperRow>
      )}
      {roundingIdr !== 0 && (
        <PaperRow label={t("posCorrection.receipt.rounding")}>
          <Money amount={roundingIdr} className="font-semibold" />
        </PaperRow>
      )}
      <PaperRow label={t("posCorrection.receipt.total")} strong>
        <Money amount={Number(document.totalIdr)} />
      </PaperRow>
      <PaperRule />
      {document.tenders.map((tender, index) => (
        <PaperRow
          key={`${tender.method}-${index}`}
          label={t(
            METHOD_LABEL_KEYS[tender.method] ?? "posCorrection.method.cash",
          )}
        >
          <Money amount={Number(tender.amountIdr)} className="font-semibold" />
        </PaperRow>
      ))}
      <p className="text-center text-sm text-muted-foreground">
        {t(
          document.status === "voided"
            ? "posCorrection.receipt.voidedLine"
            : "posCorrection.receipt.paidLine",
        )}
      </p>
    </article>
  );
}

function PreviewSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" role="status" className="grid gap-3">
      <span className="sr-only">{t("posCorrection.state.loading")}</span>
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// The receipt of a paid order: a preview of what prints, and the print action.
// The receipt number stays on record even if the sale is voided (POS-06). A
// second print is a reprint, marked as such on the paper.
export function ReceiptPreview({ order, subtitle, switcher }: Props) {
  const t = useT();
  const receiptId = order.receipt?.id ?? null;
  const document = useReceiptDocument(receiptId);
  const print = usePrintReceipt();

  const paid = order.status === "completed";
  const printed = print.data;
  const body = !paid ? (
    <StateBlock
      title={t("posCorrection.receipt.notPaidTitle")}
      description={t("posCorrection.receipt.notPaidBody")}
    />
  ) : receiptId === null ? (
    <StateBlock
      title={t("posCorrection.receipt.noReceiptTitle")}
      description={t("posCorrection.receipt.noReceiptBody")}
    />
  ) : document.isLoading ? (
    <PreviewSkeleton />
  ) : document.isError ? (
    <ErrorState
      error={document.error}
      title={t("posCorrection.state.errorTitle")}
      description={t("posCorrection.state.errorBody")}
      action={
        <Button type="button" onClick={() => void document.refetch()}>
          <RotateCw aria-hidden="true" />
          {t("common.retry")}
        </Button>
      }
    />
  ) : document.data ? (
    <ReceiptPaper document={document.data} />
  ) : null;

  const canPrint = paid && (receiptId === null || document.data !== undefined);
  const printLabel =
    receiptId === null
      ? "posCorrection.actions.issueReceipt"
      : printed || order.receipt?.reprintCount
        ? "posCorrection.actions.printAgain"
        : "posCorrection.actions.printReceipt";

  return (
    <CorrectionLayout
      title={t("posCorrection.title.struk")}
      subtitle={subtitle}
      switcher={switcher}
      sideTitle={t("posCorrection.receipt.panelTitle")}
      side={
        <>
          <p>{t("posCorrection.receipt.panelHint")}</p>
          <Notice tone="info" title={t("posCorrection.receipt.savedTitle")}>
            {t("posCorrection.receipt.savedBody")}
          </Notice>
        </>
      }
      panelTitle={t("posCorrection.receipt.previewTitle")}
      footer={
        <>
          <BackButton />
          {canPrint && (
            <Button
              type="button"
              loading={print.isPending}
              onClick={() => print.mutate(order.id)}
            >
              {t(printLabel)}
            </Button>
          )}
        </>
      }
    >
      {body}
      {printed?.tabletPrint === "failed" && (
        <Notice
          tone="warning"
          title={t("posKasirCommon.printer.notSent.failed.title", {
            receiptNo: printed.receipt.number,
          })}
        >
          {t("posKasirCommon.printer.notSent.failed.body")}
        </Notice>
      )}
      {printed &&
        printed.tabletPrint !== "failed" &&
        printed.printResult !== "queued_to_printer" && (
          <Notice
            tone="warning"
            title={t("posCorrection.receipt.notPrintedTitle")}
          >
            {t("posCorrection.receipt.notPrintedBody", {
              receiptNo: printed.receipt.number,
            })}
          </Notice>
        )}
      {printed?.printResult === "queued_to_printer" &&
        printed.tabletPrint !== "failed" && (
          <Notice tone="info" title={t("posCorrection.receipt.printedTitle")}>
            {t("posCorrection.receipt.printedBody", {
              receiptNo: printed.receipt.number,
            })}
          </Notice>
        )}
      {print.isError && (
        <Notice tone="danger" title={t("posCorrection.state.submitErrorTitle")}>
          {correctionErrorText(
            print.error,
            t("posCorrection.state.submitErrorBody"),
          )}
        </Notice>
      )}
    </CorrectionLayout>
  );
}
