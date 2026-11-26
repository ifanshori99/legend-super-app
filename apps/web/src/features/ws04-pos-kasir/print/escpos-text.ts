// The browser fallback (P2): reads the cloud's ESC/POS job back into its text
// lines and lays them out as HTML for 58/80 mm paper. One source of truth: the
// copy from window.print says exactly what RawBT would print, "CETAK ULANG"
// banner included. Knows the commands of apps/api/src/edge/print/escpos.ts and
// skips anything else. Pure: Node tests load it directly.
import type { PrintPaperWidth } from "@starter/shared/pos";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type EscposLine = {
  text: string;
  align: "left" | "center" | "right";
  bold: boolean;
  size: "normal" | "double" | "tall";
};

const ALIGNS = ["left", "center", "right"] as const;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function escposLines(escposBase64: string): EscposLine[] {
  const bytes = decodeBase64(escposBase64);
  const lines: EscposLine[] = [];
  let text = "";
  let align: EscposLine["align"] = "left";
  let bold = false;
  let size: EscposLine["size"] = "normal";
  const flush = () => {
    lines.push({ text, align, bold, size });
    text = "";
  };
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i] ?? 0;
    const command = bytes[i + 1];
    const arg = bytes[i + 2] ?? 0;
    if (byte === ESC) {
      if (command === 0x40) {
        align = "left";
        bold = false;
        size = "normal";
        i += 2;
      } else if (command === 0x61) {
        align = ALIGNS[arg] ?? "left";
        i += 3;
      } else if (command === 0x45) {
        bold = arg !== 0;
        i += 3;
      } else if (command === 0x64) {
        if (text !== "") flush();
        for (let n = 0; n < arg; n += 1) flush();
        i += 3;
      } else if (command === 0x74) i += 3;
      else i += 2;
    } else if (byte === GS) {
      if (command === 0x21) {
        size = arg === 0x11 ? "double" : arg === 0x01 ? "tall" : "normal";
        i += 3;
      } else if (command === 0x56) i += arg === 65 || arg === 66 ? 4 : 3;
      else i += 2;
    } else {
      if (byte === LF) flush();
      else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
      i += 1;
    }
  }
  if (text !== "") flush();
  while (lines.at(-1)?.text === "") lines.pop();
  return lines;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A standalone page for the print dialog, one paper width wide. */
export function receiptHtml(
  lines: readonly EscposLine[],
  paperWidth: PrintPaperWidth,
): string {
  const paper = paperWidth === 48 ? "80mm" : "58mm";
  const body = lines
    .map((line) => {
      const classes = [line.align, line.bold ? "b" : "", line.size]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}">${escapeHtml(line.text) || "&nbsp;"}</div>`;
    })
    .join("");
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Struk</title><style>
@page { size: ${paper} auto; margin: 0; }
html, body { margin: 0; background: #fff; color: #000; }
body { width: ${paper}; padding: 2mm 3mm; box-sizing: border-box; font: 2.5mm/1.35 ui-monospace, "Courier New", monospace; }
div { white-space: pre; overflow: hidden; }
.center { text-align: center; } .right { text-align: right; }
.b { font-weight: 700; } .double { font-size: 5mm; font-weight: 700; } .tall { line-height: 2.7; font-weight: 700; }
</style></head><body>${body}</body></html>`;
}
