// "Cetak tes" in the printer settings (review P2 no. 6): a short ESC/POS page
// built on the tablet, so the cashier can check RawBT and the paper width
// before the first sale. A full-width ruler shows whether the width is right.
import type { PrintPaperWidth, PrintPayload } from "@starter/shared/pos";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export function testPrintPayload(paperWidth: PrintPaperWidth): PrintPayload {
  const bytes: number[] = [ESC, 0x40, ESC, 0x74, 0x00];
  const line = (text: string) => {
    for (const char of text) bytes.push(char.charCodeAt(0));
    bytes.push(LF);
  };
  bytes.push(ESC, 0x61, 1, ESC, 0x45, 1);
  line("TES PRINTER");
  bytes.push(ESC, 0x45, 0);
  line(`${paperWidth === 48 ? "80" : "58"} mm - ${paperWidth} karakter`);
  bytes.push(ESC, 0x61, 0);
  line("-".repeat(paperWidth));
  line("1234567890".repeat(5).slice(0, paperWidth));
  line("-".repeat(paperWidth));
  bytes.push(ESC, 0x64, 3, GS, 0x56, 66, 3);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { paperWidth, escposBase64: btoa(binary), reprint: false };
}
