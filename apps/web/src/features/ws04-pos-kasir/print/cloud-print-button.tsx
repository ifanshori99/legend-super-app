import { useState } from "react";
import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import {
  printFromCloud,
  wasSentToPrinter,
  type CloudPrintLoader,
} from "./cloud-print";
import { readTabletPrinter } from "./printer-settings";
import type { TabletPrintOutcome } from "./send-to-printer";
import { TabletPrinterSettings } from "./tablet-printer-settings";

type Status =
  | { kind: TabletPrintOutcome; reprint: boolean }
  | { kind: "loadFailed"; message: string | null };

// P3: print what this screen shows on this tablet's printer. After a send the
// screen stays and the next tap is a "Cetak ulang" (the cloud marks the bytes).
// The page never learns whether paper came out, so the status is "dikirim".
export function CloudPrintButton({
  printKey,
  load,
  kind,
  size = "default",
  className,
}: {
  /** Identifies the thing printed; a second send of the same key is a reprint. */
  printKey: string;
  load: CloudPrintLoader;
  kind: "ticket" | "shift";
  size?: "default" | "sm";
  className?: string;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  // Re-read after each send: a key sent earlier on this page is a reprint.
  const [sentBefore, setSentBefore] = useState(() =>
    wasSentToPrinter(printKey),
  );

  const send = async () => {
    setPending(true);
    try {
      const result = await printFromCloud(printKey, load, readTabletPrinter());
      setStatus({ kind: result.outcome, reprint: result.reprint });
      setSentBefore(wasSentToPrinter(printKey));
    } catch (error) {
      setStatus({
        kind: "loadFailed",
        message: error instanceof ApiError ? error.message : null,
      });
    } finally {
      setPending(false);
    }
  };

  const text = !status
    ? null
    : status.kind === "loadFailed"
      ? (status.message ?? t("posKasirCommon.printer.cloud.loadFailed"))
      : status.kind === "none"
        ? t("posKasirCommon.printer.cloud.none")
        : status.kind === "failed"
          ? t("posKasirCommon.printer.cloud.failed")
          : status.reprint
            ? t("posKasirCommon.printer.cloud.sentAgain")
            : t("posKasirCommon.printer.cloud.sent");
  const needsPrinterChange =
    status?.kind === "none" || status?.kind === "failed";

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size={size}
          loading={pending}
          className={size === "sm" ? "flex-1" : undefined}
          onClick={() => void send()}
        >
          <Printer aria-hidden="true" />
          {t(
            sentBefore
              ? `posKasirCommon.printer.cloud.${kind}Again`
              : `posKasirCommon.printer.cloud.${kind}`,
          )}
        </Button>
        {needsPrinterChange && <TabletPrinterSettings variant="button" />}
      </div>
      <p aria-live="polite" role="status" className="mt-2 text-base">
        {text}
      </p>
    </div>
  );
}
