// Embedded PDF fonts shared by the pdf-lib renderers (menu print, later payslip
// and receipt). Noto Sans subset (Latin, Latin Extended, Greek, Cyrillic; SIL
// OFL, see apps/api/assets/fonts).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FONT_FILES = {
  regular: "NotoSans-Regular-subset.ttf",
  bold: "NotoSans-Bold-subset.ttf",
} as const;
type FontWeight = keyof typeof FONT_FILES;

const cache = new Map<FontWeight, Uint8Array>();

/**
 * Font bytes. The production bundle copies `assets/` next to the server files
 * (tsup `publicDir`, so `dist/fonts/`); from source (tests, tsx) the files sit
 * in `apps/api/assets/fonts/`.
 */
function fontBytes(weight: FontWeight): Uint8Array {
  const cached = cache.get(weight);
  if (cached) return cached;
  const file = FONT_FILES[weight];
  const candidates = [
    new URL(`./fonts/${file}`, import.meta.url),
    new URL(`../../../assets/fonts/${file}`, import.meta.url),
  ];
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`PDF font missing: ${file}`);
  const bytes = new Uint8Array(readFileSync(found));
  cache.set(weight, bytes);
  return bytes;
}

export function loadPdfFonts(): { regular: Uint8Array; bold: Uint8Array } {
  return { regular: fontBytes("regular"), bold: fontBytes("bold") };
}
