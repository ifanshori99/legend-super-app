import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useReceiptPdf } from "../../hooks";
import { TabletPrinterSettings } from "../../print/tablet-printer-settings";
import type { ReceiptResult } from "../../types";
import { Notice } from "../shared";

// Nothing went to a printer (legend-9yw78.6): say why, then the way out:
// change the printer and print again, or keep the PDF (review P2 no. 3).
export function ReceiptNotPrinted({
  result,
  onSkip,
  onReprint,
  reprinting = false,
}: {
  result: ReceiptResult;
  /** Move on without paper; absent where the screen has its own way out. */
  onSkip?: () => void;
  /** Print again (a reprint), e.g. after changing the printer. */
  onReprint?: () => void;
  reprinting?: boolean;
}) {
  const t = useT();
  const pdf = useReceiptPdf();
  const { receiptId, receiptNo, tabletPrint } = result;
  const cause =
    tabletPrint === "failed" || tabletPrint === "none" ? tabletPrint : null;
  return (
    <div
      aria-live="polite"
      className="grid w-full max-w-2xl justify-items-start gap-3 text-left"
    >
      <Notice
        tone="warning"
        title={
          cause
            ? t(`posKasirCommon.printer.notSent.${cause}.title`, { receiptNo })
            : t("posKasirGateway.receipt.notPrintedTitle", { receiptNo })
        }
        className="w-full"
      >
        {cause
          ? t(`posKasirCommon.printer.notSent.${cause}.body`)
          : t("posKasirGateway.receipt.notPrintedBody")}
      </Notice>
      <div className="flex flex-wrap gap-3">
        <TabletPrinterSettings variant="button" />
        {onReprint && (
          <Button
            type="button"
            variant="outline"
            loading={reprinting}
            onClick={onReprint}
          >
            {t("posKasirCommon.printer.reprint")}
          </Button>
        )}
        {receiptId && (
          <Button
            type="button"
            variant="outline"
            loading={pdf.isPending}
            onClick={() => pdf.mutate({ receiptId, receiptNo })}
          >
            {t("posKasirGateway.receipt.pdf")}
          </Button>
        )}
        {onSkip && (
          <Button type="button" variant="outline" onClick={onSkip}>
            {t("posKasirGateway.receipt.skipPrint")}
          </Button>
        )}
      </div>
      {pdf.error && (
        <Notice
          tone="danger"
          title={t("posKasirGateway.receipt.pdfError")}
          className="w-full"
        >
          {pdf.error.message}
        </Notice>
      )}
    </div>
  );
}

/** The only result that may mean paper: anything else is not a print. */
export const wasQueued = (result: ReceiptResult) =>
  result.printResult === "queued_to_printer" && result.tabletPrint !== "failed";
