import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice } from "../shared";

// The receipt went to the printer (review P2 no. 2). The page never learns
// whether paper came out, so the screen stays: the cashier checks the paper
// and either prints again or moves on.
export function ReceiptSent({
  receiptNo,
  onReprint,
  onNext,
  reprinting = false,
}: {
  receiptNo: string;
  onReprint: () => void;
  /** Move on to a new sale; absent where the screen has its own way out. */
  onNext?: () => void;
  reprinting?: boolean;
}) {
  const t = useT();
  return (
    <div
      aria-live="polite"
      className="grid w-full max-w-2xl justify-items-start gap-3 text-left"
    >
      <Notice
        tone="info"
        title={t("posKasirCommon.printer.sentTitle", { receiptNo })}
        className="w-full"
      >
        {t("posKasirCommon.printer.sentNote")}
      </Notice>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          loading={reprinting}
          onClick={onReprint}
        >
          {t("posKasirCommon.printer.reprint")}
        </Button>
        {onNext && (
          <Button type="button" onClick={onNext}>
            {t("posKasirCommon.printer.next")}
          </Button>
        )}
      </div>
    </div>
  );
}
