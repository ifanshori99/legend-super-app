// Text extraction for the PDFs pdf-lib writes (embedded Noto Sans, glyph ids
// in the content stream), shared by the PO PDF tests (bead legend-uokb).
import { inflateSync } from "node:zlib";

export type Drawn = { text: string; size: number; x: number; y: number };

/**
 * Minimal PDF text extraction for pdf-lib output: inflate the streams, read
 * each embedded font's ToUnicode CMap and decode the `<hex> Tj` strings. Not a
 * general parser; it only has to read what the renderer writes.
 */
export function drawnText(pdf: Buffer): Drawn[] {
  const raw = pdf.toString("latin1");
  const objects = new Map<number, { dict: string; data: string | null }>();
  for (const match of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    const body = match[2] ?? "";
    const split = body.indexOf("stream\n");
    const dict = split < 0 ? body : body.slice(0, split);
    let data: string | null = null;
    if (split >= 0) {
      const bytes = Buffer.from(
        body.slice(split + 7, body.lastIndexOf("\nendstream")),
        "latin1",
      );
      data = (
        dict.includes("/FlateDecode") ? inflateSync(bytes) : bytes
      ).toString("latin1");
    }
    objects.set(Number(match[1]), { dict, data });
  }
  const cmaps = new Map<string, Map<string, string>>();
  for (const [, { dict }] of objects) {
    for (const font of dict.matchAll(/\/(\S+) (\d+) 0 R/g)) {
      const target = objects.get(Number(font[2]));
      const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(target?.dict ?? "");
      const cmap = objects.get(Number(toUnicode?.[1]))?.data;
      if (!cmap || cmaps.has(font[1] as string)) continue;
      const map = new Map<string, string>();
      for (const pair of cmap.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/gi)) {
        const units = (pair[2] as string).match(/.{4}/g) ?? [];
        map.set(
          (pair[1] as string).toLowerCase(),
          units.map((unit) => String.fromCharCode(parseInt(unit, 16))).join(""),
        );
      }
      cmaps.set(font[1] as string, map);
    }
  }
  const out: Drawn[] = [];
  for (const [, { data }] of objects) {
    if (!data?.includes(" Tf")) continue;
    let font = "";
    let size = 0;
    let x = 0;
    let y = 0;
    for (const op of data.matchAll(
      /\/(\S+) ([\d.]+) Tf|1 0 0 1 ([\d.]+) ([\d.]+) Tm|<([0-9a-f]+)> Tj/gi,
    )) {
      if (op[1]) {
        font = op[1];
        size = Number(op[2]);
      } else if (op[3]) {
        x = Number(op[3]);
        y = Number(op[4]);
      } else {
        const map = cmaps.get(font);
        const codes = (op[5] as string).match(/.{4}/g) ?? [];
        const text = codes
          .map((code) => map?.get(code.toLowerCase()) ?? "\uFFFD")
          .join("");
        out.push({ text, size, x, y });
      }
    }
  }
  return out;
}

export const allText = (pdf: Buffer) =>
  drawnText(pdf)
    .map((entry) => entry.text)
    .join("\n");
