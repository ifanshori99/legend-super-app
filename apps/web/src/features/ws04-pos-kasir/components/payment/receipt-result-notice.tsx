import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useReceiptPdf } from "../../hooks";
import { TabletPrinterSettings } from "../../print/tablet-printer-settings";
import type { ReceiptResult } from "../../types";
import { Notice } from "../shared";

// The server said nothing was printed (legend-9yw78.6): say so, offer the PDF.
export function ReceiptNotPrinted({
  result,
  onSkip,
}: {
  result: ReceiptResult;
  /** Move on without paper; absent where the screen has its own way out. */
  onSkip?: () => void;
}) {
  const t = useT();
  const pdf = useReceiptPdf();
  const { receiptId, receiptNo } = result;
  return (
    <div className="grid w-full max-w-2xl justify-items-start gap-3 text-left">
      <Notice
        tone="warning"
        title={t("posKasirGateway.receipt.notPrintedTitle", { receiptNo })}
        className="w-full"
      >
        {t("posKasirGateway.receipt.notPrintedBody")}
      </Notice>
      <div className="flex flex-wrap gap-3">
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
        <TabletPrinterSettings variant="button" />
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
  result.printResult === "queued_to_printer";
