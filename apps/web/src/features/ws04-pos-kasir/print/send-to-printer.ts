// Hands the cloud's ESC/POS job to this tablet's printer (P2,
// docs/design/cloud-only-release.md section 3). RawBT takes the bytes as its
// "rawbt:base64," intent and reaches Bluetooth, USB or LAN printers; the
// browser fallback prints the same lines through window.print. Neither tells
// the page whether paper came out, so the result is "sent", never "printed".
import type { PrintPayload } from "@starter/shared/pos";
import { escposLines, receiptHtml } from "./escpos-text.ts";
import type { PrinterMethod, TabletPrinter } from "./printer-settings.ts";

export type PrinterIo = {
  openUrl: (url: string) => void;
  printHtml: (html: string) => void;
};

export const rawbtUrl = (escposBase64: string) =>
  `rawbt:base64,${escposBase64}`;

type FrameDocument = {
  createElement: (tag: "iframe") => HTMLIFrameElement;
  body: { append: (node: HTMLIFrameElement) => void };
};

/** Prints a standalone page from a hidden frame, then removes the frame. */
export function printHtmlInFrame(
  html: string,
  doc: FrameDocument = document,
): void {
  const frame = doc.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    const view = frame.contentWindow;
    if (!view) {
      frame.remove();
      return;
    }
    // Some browsers never fire afterprint; never leave the frame behind.
    const timer = setTimeout(() => frame.remove(), 60_000);
    view.addEventListener(
      "afterprint",
      () => {
        clearTimeout(timer);
        frame.remove();
      },
      { once: true },
    );
    try {
      view.focus();
      view.print();
    } catch {
      clearTimeout(timer);
      frame.remove();
    }
  };
  frame.srcdoc = html;
  doc.body.append(frame);
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

/**
 * What happened on this tablet: `none` (no printer chosen), `skipped` (no
 * bytes: the edge or the mock printed), `sent`, or `failed`. Never throws: the
 * receipt is already issued, so a printer problem must not look like a failed
 * receipt (review P2 no. 7).
 */
export type TabletPrintOutcome = "none" | "skipped" | "sent" | "failed";

export function deliverToTabletPrinter(
  payload: PrintPayload | null | undefined,
  printer: TabletPrinter,
  io: PrinterIo = browserIo,
): { outcome: TabletPrintOutcome } {
  if (printer.method === "none") return { outcome: "none" };
  if (!payload) return { outcome: "skipped" };
  try {
    sendToPrinter(payload, printer.method, io);
    return { outcome: "sent" };
  } catch {
    return { outcome: "failed" };
  }
}
