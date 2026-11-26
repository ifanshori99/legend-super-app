// Hands the cloud's ESC/POS job to this tablet's printer (P2,
// docs/design/cloud-only-release.md section 3). RawBT takes the bytes as its
// "rawbt:base64," intent and reaches Bluetooth, USB or LAN printers; the
// browser fallback prints the same lines through window.print. Neither tells
// the page whether paper came out, so the result is "sent", never "printed".
import type { PrintPayload } from "@starter/shared/pos";
import { escposLines, receiptHtml } from "./escpos-text.ts";
import type { PrinterMethod } from "./printer-settings.ts";

export type PrinterIo = {
  openUrl: (url: string) => void;
  printHtml: (html: string) => void;
};

export const rawbtUrl = (escposBase64: string) =>
  `rawbt:base64,${escposBase64}`;

/** Prints a standalone page from a hidden frame, then removes the frame. */
function printHtmlInFrame(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    const view = frame.contentWindow;
    if (!view) return;
    view.addEventListener("afterprint", () => frame.remove(), { once: true });
    view.focus();
    view.print();
    // Some browsers never fire afterprint; never leave the frame behind.
    window.setTimeout(() => frame.remove(), 60_000);
  };
  frame.srcdoc = html;
  document.body.append(frame);
}

const browserIo: PrinterIo = {
  openUrl: (url) => {
    window.location.href = url;
  },
  printHtml: printHtmlInFrame,
};

export function sendToPrinter(
  payload: PrintPayload,
  method: PrinterMethod,
  io: PrinterIo = browserIo,
): "sent" | "skipped" {
  if (method === "rawbt") {
    io.openUrl(rawbtUrl(payload.escposBase64));
    return "sent";
  }
  if (method === "browser") {
    io.printHtml(
      receiptHtml(escposLines(payload.escposBase64), payload.paperWidth),
    );
    return "sent";
  }
  return "skipped";
}
