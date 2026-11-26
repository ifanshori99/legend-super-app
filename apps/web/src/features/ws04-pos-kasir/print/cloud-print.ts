// P3 (docs/design/cloud-only-release.md section 3): a kitchen ticket or a shift
// report is printed from the tablet that shows it. The cloud renders the ESC/POS
// bytes and this tablet sends them to its own printer. The cloud never learns
// whether paper came out, so the tablet remembers what it already sent and asks
// for the "CETAK ULANG" banner on every later print of the same thing.
import type { PrintPaperWidth, PrintPayload } from "@starter/shared/pos";
import {
  deliverToTabletPrinter,
  type PrinterIo,
  type TabletPrintOutcome,
} from "./send-to-printer.ts";
import type { TabletPrinter } from "./printer-settings.ts";

export type CloudPrintLoader = (ask: {
  paperWidth: PrintPaperWidth;
  reprint: boolean;
}) => Promise<PrintPayload>;

/** What this page already sent to the printer, by ticket or shift key. */
const sentThisSession = new Set<string>();

/**
 * Fetches the bytes and sends them to the printer. A failed fetch throws (the
 * caller shows it apart from the printer); a printer problem is an outcome.
 * No printer chosen asks the cloud for nothing.
 */
export async function printFromCloud(
  key: string,
  load: CloudPrintLoader,
  printer: TabletPrinter,
  io?: PrinterIo,
  sent: Set<string> = sentThisSession,
): Promise<{ outcome: TabletPrintOutcome; reprint: boolean }> {
  if (printer.method === "none") return { outcome: "none", reprint: false };
  const reprint = sent.has(key);
  const payload = await load({ paperWidth: printer.paperWidth, reprint });
  const { outcome } = deliverToTabletPrinter(payload, printer, io);
  if (outcome === "sent") sent.add(key);
  // The cloud decides: it marks every later print of a key it already served.
  return { outcome, reprint: payload.reprint };
}

/** True once this page sent `key` to the printer: the next print is a reprint. */
export const wasSentToPrinter = (
  key: string,
  sent: Set<string> = sentThisSession,
) => sent.has(key);
