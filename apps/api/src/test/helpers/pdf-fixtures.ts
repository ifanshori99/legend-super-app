// Real PDFs for tests, built with pdf-lib (no binary fixtures in the repo).
// `uploadStorage` parses document PDFs (`assertSafePdf`, legend-851ef), so a
// minimal fake like "%PDF-1.4\n%%EOF" is now refused with 422.
import { PDFDocument } from "pdf-lib";

/** A valid, unencrypted PDF with no active content. `marker` (drawn as text)
 * makes the bytes differ between calls when a test needs distinct files. */
export async function validPdfBytes(
  options: { pages?: number; marker?: string } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pages = options.pages ?? 1;
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200]);
    if (options.marker && i === 0)
      page.drawText(options.marker, { x: 10, y: 100, size: 10 });
  }
  return doc.save();
}
