// QR encoding for every screen that shows a scannable code (bead legend-9fmm:
// one renderer instead of qrcode + qrcode.react + uqr). `uqr` is pure: it
// encodes a payload to a module matrix in any runtime, so the same code renders
// during SSR and in the browser without a canvas. Screens draw the result
// through `components/ui/qr-code.tsx`; nothing else imports `uqr`.
import { encode } from "uqr";

export type QrLevel = "L" | "M" | "Q" | "H";

export type QrModules = {
  /** Matrix width in modules, quiet zone included. */
  size: number;
  /** Row-major matrix; `true` is a dark module. */
  data: boolean[][];
};

/**
 * Encodes a payload at the given error correction level. `margin` is the quiet
 * zone in modules: a scanner needs a light border around the code, and the
 * printable labels keep at least 2 (the QR spec asks for 4).
 */
export function encodeQr(
  value: string,
  { level = "M", margin = 2 }: { level?: QrLevel; margin?: number } = {},
): QrModules {
  const { size, data } = encode(value, { ecc: level, border: margin });
  return { size, data };
}

/**
 * Compresses the dark modules of a QR code into one SVG path (`h1v1h-1z`
 * squares in module coordinates), so a code is a single element rather than
 * hundreds of `<rect>`s. Pair with `shape-rendering: crispEdges` and a light
 * plate: modules are drawn in `currentColor`.
 */
export function qrModulePath(
  value: string,
  options?: { level?: QrLevel; margin?: number },
): { size: number; path: string } {
  const { size, data } = encodeQr(value, options);
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1)
      if (data[y]?.[x]) parts.push(`M${x} ${y}h1v1h-1z`);
  return { size, path: parts.join("") };
}
