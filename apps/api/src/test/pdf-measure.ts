// Test helper: measure text width with the real bundled Noto Sans (fontkit),
// so layout tests run with the same metrics the PDF engine draws with.
import fontkit from "@pdf-lib/fontkit";
import { loadPdfFonts } from "../services/pdf/pdf-fonts";

type Face = ReturnType<typeof fontkit.create>;
let faces: { regular: Face; bold: Face } | null = null;

function loadFaces() {
  if (!faces) {
    const bytes = loadPdfFonts();
    faces = {
      regular: fontkit.create(bytes.regular),
      bold: fontkit.create(bytes.bold),
    };
  }
  return faces;
}

/** Width in PDF points of `text` at `size`. */
export function realMeasure(text: string, bold: boolean, size: number) {
  const face = bold ? loadFaces().bold : loadFaces().regular;
  const run = face.layout(text);
  const units = run.glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0);
  return (units / face.unitsPerEm) * size;
}

export function hasGlyph(codePoint: number) {
  return loadFaces().regular.hasGlyphForCodePoint(codePoint);
}
