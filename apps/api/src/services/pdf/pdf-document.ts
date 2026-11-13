// Generic block-to-PDF engine on pdf-lib (menu print now; payslip and receipt
// later). `layoutPdfDocument` is pure: it takes a text measure and returns
// positioned text and lines per page, so layout is testable without a font.
// `renderPdfDocument` measures with the embedded Noto Sans subset and draws.
//
// Coordinates are PDF points with the origin at the bottom-left. `y` of a text
// is its baseline.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { loadPdfFonts } from "./pdf-fonts.ts";

export type PdfBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | {
      type: "text";
      text: string;
      bold?: boolean;
      muted?: boolean;
      size?: number;
      align?: "left" | "right" | "center";
    }
  | {
      type: "table";
      columns: {
        header: string;
        /** Fraction of the content width; the columns sum to about 1. */
        width: number;
        align?: "left" | "right";
      }[];
      rows: string[][];
    }
  | { type: "rule" }
  | { type: "spacer"; height?: number };

export interface PdfDocumentSpec {
  /** PDF metadata title. */
  title: string;
  header?: {
    title: string;
    subtitle?: string;
    logo?: { bytes: Uint8Array; kind: "png" | "jpg" };
  };
  blocks: PdfBlock[];
  /** Printed on every page, with "Halaman n/N". */
  footer?: string;
  page?: { size?: "A4"; margin?: number };
}

export interface PdfLayoutText {
  page: number;
  x: number;
  y: number;
  text: string;
  bold: boolean;
  size: number;
  muted?: boolean;
}

export interface PdfLayoutLine {
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  /** Light separator instead of a dark rule. */
  light: boolean;
}

export interface PdfLayoutResult {
  pages: PdfLayoutText[][];
  lines: PdfLayoutLine[][];
  /** Box on page 0 where the header logo is fitted (aspect kept). */
  logo?: { x: number; y: number; width: number; height: number };
}

export type PdfMeasure = (text: string, bold: boolean, size: number) => number;
/** True when the font can draw the code point. */
export type PdfHasGlyph = (codePoint: number) => boolean;

const A4 = { width: 595.28, height: 841.89 };
const DEFAULT_MARGIN = 48;
const BODY_SIZE = 10;
const LINE = 1.35;
const CELL_PAD_X = 4;
const CELL_PAD_Y = 3;
const FOOTER_SIZE = 8;
const LOGO_SIZE = 44;
const HEADING_SIZE = { 1: 18, 2: 13, 3: 11 } as const;
const HEADING_BEFORE = { 1: 12, 2: 14, 3: 8 } as const;

/**
 * Fallback when no font is supplied: Basic Latin, Latin-1, Latin Extended,
 * Greek, Cyrillic, general punctuation and currency symbols (what the bundled
 * Noto Sans subset covers). Emoji and CJK fall outside.
 */
export const defaultHasGlyph: PdfHasGlyph = (cp) =>
  (cp >= 0x20 && cp <= 0x7e) ||
  (cp >= 0xa0 && cp <= 0x24f) ||
  (cp >= 0x370 && cp <= 0x52f) ||
  (cp >= 0x2010 && cp <= 0x20bf);

/** Zero-width and variation selectors: dropped, they draw nothing. */
function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2060 ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

/**
 * Line breaks stay as `\n` (hard breaks); tabs print as a space, other control
 * characters vanish, characters the font lacks become `?`.
 */
function sanitize(text: string, hasGlyph: PdfHasGlyph): string {
  let out = "";
  for (const char of text.replace(/\r\n?/g, "\n")) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 10) out += "\n";
    else if (cp === 9) out += " ";
    else if (cp < 32 || (cp >= 0x7f && cp <= 0x9f) || isInvisible(cp)) continue;
    else out += hasGlyph(cp) ? char : "?";
  }
  return out;
}

/** Greedy word wrap per paragraph; a word wider than the line breaks by character. */
function wrapText(
  text: string,
  maxWidth: number,
  bold: boolean,
  size: number,
  measure: PdfMeasure,
): string[] {
  const width = (value: string) => measure(value, bold, size);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ").filter((word) => word !== "");
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (width(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current !== "") lines.push(current);
      current = "";
      let rest = Array.from(word);
      while (rest.length > 1 && width(rest.join("")) > maxWidth) {
        let take = 1;
        while (
          take < rest.length &&
          width(rest.slice(0, take + 1).join("")) <= maxWidth
        )
          take += 1;
        lines.push(rest.slice(0, take).join(""));
        rest = rest.slice(take);
      }
      current = rest.join("");
    }
    if (current !== "") lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
}

type TableState = {
  drawHeader: (top: number) => void;
  headerHeight: number;
  lastPage: number;
};

type Item = {
  /** Space above, dropped at the top of a page. */
  before: number;
  height: number;
  /** Stay on the same page as the next item. */
  keep: boolean;
  draw: (top: number) => void;
  table?: TableState;
  /** Body row (repeats the table header after a page break). */
  row?: boolean;
  /** Table header row (records the page it was drawn on). */
  header?: boolean;
};

export function layoutPdfDocument(
  spec: PdfDocumentSpec,
  measure: PdfMeasure,
  hasGlyph: PdfHasGlyph = defaultHasGlyph,
): PdfLayoutResult {
  const margin = spec.page?.margin ?? DEFAULT_MARGIN;
  const pageWidth = A4.width;
  const pageHeight = A4.height;
  const left = margin;
  const contentWidth = pageWidth - margin * 2;
  const contentTop = pageHeight - margin;
  const clean = (text: string) => sanitize(text, hasGlyph);

  // Footer band: reserved on every page.
  const footerText = spec.footer === undefined ? null : clean(spec.footer);
  const footerLh = FOOTER_SIZE * LINE;
  const pageNumberWidth = measure("Halaman 99/99", false, FOOTER_SIZE);
  const footerLines =
    footerText === null
      ? []
      : wrapText(
          footerText,
          Math.max(contentWidth - pageNumberWidth - 12, 40),
          false,
          FOOTER_SIZE,
          measure,
        );
  const footerHeight = footerText === null ? 0 : footerLines.length * footerLh;
  const contentBottom =
    footerText === null ? margin : margin + footerHeight + 10;
  const contentHeight = contentTop - contentBottom;

  const pageTexts: PdfLayoutText[][] = [[]];
  const pageLines: PdfLayoutLine[][] = [[]];
  let page = 0;
  let cursor = contentTop;

  const put = (
    x: number,
    y: number,
    text: string,
    bold: boolean,
    size: number,
    muted = false,
  ) => {
    if (text === "") return;
    const entry: PdfLayoutText = { page, x, y, text, bold, size };
    if (muted) entry.muted = true;
    pageTexts[page]?.push(entry);
  };
  const putLine = (
    x1: number,
    y: number,
    x2: number,
    thickness: number,
    light: boolean,
  ) => {
    pageLines[page]?.push({ page, x1, y1: y, x2, y2: y, thickness, light });
  };
  const alignedX = (
    text: string,
    bold: boolean,
    size: number,
    boxLeft: number,
    boxWidth: number,
    align: "left" | "right" | "center",
  ) => {
    if (align === "left") return boxLeft;
    const free = boxWidth - measure(text, bold, size);
    return boxLeft + (align === "right" ? free : free / 2);
  };

  const items: Item[] = [];
  let logo: PdfLayoutResult["logo"];

  // ---- header
  if (spec.header) {
    const hasLogo = spec.header.logo !== undefined;
    const textWidth = contentWidth - (hasLogo ? LOGO_SIZE + 12 : 0);
    const titleSize = 20;
    const subSize = 10;
    const titleLines = wrapText(
      clean(spec.header.title),
      textWidth,
      true,
      titleSize,
      measure,
    );
    const subtitle =
      spec.header.subtitle === undefined
        ? []
        : wrapText(
            clean(spec.header.subtitle),
            textWidth,
            false,
            subSize,
            measure,
          );
    const titleLh = titleSize * 1.25;
    const subLh = subSize * LINE;
    const textHeight = titleLines.length * titleLh + subtitle.length * subLh;
    const height = Math.max(textHeight, hasLogo ? LOGO_SIZE : 0) + 6;
    if (hasLogo)
      logo = {
        x: left + contentWidth - LOGO_SIZE,
        y: contentTop - LOGO_SIZE,
        width: LOGO_SIZE,
        height: LOGO_SIZE,
      };
    items.push({
      before: 0,
      height,
      keep: false,
      draw: (top) => {
        let y = top;
        for (const line of titleLines) {
          put(left, y - titleSize * 1.0, line, true, titleSize);
          y -= titleLh;
        }
        for (const line of subtitle) {
          put(left, y - subSize * 1.0, line, false, subSize, true);
          y -= subLh;
        }
      },
    });
    items.push(ruleItem());
  }

  function ruleItem(): Item {
    return {
      before: 0,
      height: 9,
      keep: false,
      draw: (top) => putLine(left, top - 4.5, left + contentWidth, 0.8, false),
    };
  }

  // ---- blocks
  for (const block of spec.blocks) {
    if (block.type === "spacer") {
      items.push({
        before: 0,
        height: block.height ?? 8,
        keep: false,
        draw: () => {},
      });
    } else if (block.type === "rule") {
      items.push(ruleItem());
    } else if (block.type === "heading") {
      const level = block.level ?? 2;
      const size = HEADING_SIZE[level];
      const lh = size * 1.3;
      const lines = wrapText(
        clean(block.text),
        contentWidth,
        true,
        size,
        measure,
      );
      items.push({
        before: HEADING_BEFORE[level],
        height: lines.length * lh + 4,
        keep: true,
        draw: (top) => {
          lines.forEach((line, k) =>
            put(left, top - k * lh - size * 1.0, line, true, size),
          );
        },
      });
    } else if (block.type === "text") {
      const size = block.size ?? BODY_SIZE;
      const bold = block.bold ?? false;
      const align = block.align ?? "left";
      const lh = size * LINE;
      const lines = wrapText(
        clean(block.text),
        contentWidth,
        bold,
        size,
        measure,
      );
      lines.forEach((line, k) => {
        const last = k === lines.length - 1;
        items.push({
          before: 0,
          height: lh + (last ? 3 : 0),
          keep: false,
          draw: (top) =>
            put(
              alignedX(line, bold, size, left, contentWidth, align),
              top - size * 1.0,
              line,
              bold,
              size,
              block.muted,
            ),
        });
      });
    } else {
      addTable(block);
    }
  }

  function addTable(block: Extract<PdfBlock, { type: "table" }>): void {
    const columns = block.columns;
    if (columns.length === 0) return;
    const sum = columns.reduce(
      (total, col) => total + Math.max(col.width, 0),
      0,
    );
    const widths = columns.map((col) =>
      sum > 0
        ? (Math.max(col.width, 0) / sum) * contentWidth
        : contentWidth / columns.length,
    );
    const xs: number[] = [];
    let x = left;
    for (const width of widths) {
      xs.push(x);
      x += width;
    }
    const size = BODY_SIZE;
    const lh = size * LINE;
    const inner = (index: number) =>
      Math.max((widths[index] ?? 0) - CELL_PAD_X * 2, 10);

    const drawCells = (cells: string[][], top: number, bold: boolean) => {
      cells.forEach((lines, index) => {
        const align = columns[index]?.align ?? "left";
        const cellLeft = (xs[index] ?? left) + CELL_PAD_X;
        lines.forEach((line, k) => {
          put(
            alignedX(line, bold, size, cellLeft, inner(index), align),
            top - CELL_PAD_Y - size * 1.0 - k * lh,
            line,
            bold,
            size,
          );
        });
      });
    };

    const headerCells = columns.map((col, index) =>
      wrapText(clean(col.header), inner(index), true, size, measure),
    );
    const headerLines = Math.max(...headerCells.map((lines) => lines.length));
    const headerHeight = headerLines * lh + CELL_PAD_Y * 2;
    const state: TableState = {
      headerHeight,
      lastPage: -1,
      drawHeader: (top) => {
        drawCells(headerCells, top, true);
        putLine(left, top - headerHeight, left + contentWidth, 0.8, false);
      },
    };

    items.push({
      before: 4,
      height: headerHeight,
      keep: block.rows.length > 0,
      table: state,
      header: true,
      draw: (top) => state.drawHeader(top),
    });

    // A row taller than a page is cut into line chunks so it can always fit.
    const maxLines = Math.max(
      Math.floor((contentHeight - headerHeight - 60 - CELL_PAD_Y * 2) / lh),
      1,
    );
    for (const row of block.rows) {
      const cells = columns.map((_, index) =>
        wrapText(clean(row[index] ?? ""), inner(index), false, size, measure),
      );
      const total = Math.max(...cells.map((lines) => lines.length));
      for (let start = 0; start < total; start += maxLines) {
        const chunk = cells.map((lines) =>
          lines.slice(start, start + maxLines),
        );
        const chunkLines = Math.max(...chunk.map((lines) => lines.length), 1);
        const height = chunkLines * lh + CELL_PAD_Y * 2;
        const lastChunk = start + maxLines >= total;
        items.push({
          before: 0,
          height,
          keep: false,
          table: state,
          row: true,
          draw: (top) => {
            drawCells(chunk, top, false);
            if (lastChunk)
              putLine(left, top - height, left + contentWidth, 0.4, true);
          },
        });
      }
    }
  }

  // ---- pagination
  const atTop = () => cursor === contentTop;
  const newPage = () => {
    page += 1;
    pageTexts.push([]);
    pageLines.push([]);
    cursor = contentTop;
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    let need = (atTop() ? 0 : item.before) + item.height;
    for (let j = i; (items[j]?.keep ?? false) && j + 1 < items.length; j += 1) {
      const next = items[j + 1];
      if (next) need += next.before + next.height;
    }
    if (!atTop() && cursor - need < contentBottom) newPage();
    if (!atTop()) cursor -= item.before;

    if (item.row && item.table && item.table.lastPage !== page) {
      item.table.drawHeader(cursor);
      cursor -= item.table.headerHeight;
    }
    if (item.table) item.table.lastPage = page;
    item.draw(cursor);
    cursor -= item.height;
  }

  // ---- footer on every page
  if (footerText !== null) {
    const total = pageTexts.length;
    for (page = 0; page < total; page += 1) {
      footerLines.forEach((line, k) => {
        put(
          left,
          margin + (footerLines.length - 1 - k) * footerLh,
          line,
          false,
          FOOTER_SIZE,
          true,
        );
      });
      const label = `Halaman ${page + 1}/${total}`;
      put(
        left + contentWidth - measure(label, false, FOOTER_SIZE),
        margin,
        label,
        false,
        FOOTER_SIZE,
        true,
      );
      putLine(left, margin + footerHeight + 4, left + contentWidth, 0.4, true);
    }
  }

  return { pages: pageTexts, lines: pageLines, ...(logo ? { logo } : {}) };
}

type FontkitFont = ReturnType<typeof fontkit.create>;
let fontkitFonts: { regular: FontkitFont; bold: FontkitFont } | null = null;

function loadFontkitFonts() {
  if (!fontkitFonts) {
    const bytes = loadPdfFonts();
    fontkitFonts = {
      regular: fontkit.create(bytes.regular),
      bold: fontkit.create(bytes.bold),
    };
  }
  return fontkitFonts;
}

/** Measure and glyph check from the bundled Noto Sans subset (as pdf-lib draws it). */
export function createPdfFontMetrics(): {
  measure: PdfMeasure;
  hasGlyph: PdfHasGlyph;
} {
  const fonts = loadFontkitFonts();
  return {
    measure: (text, bold, size) => {
      const font = bold ? fonts.bold : fonts.regular;
      let total = 0;
      for (const glyph of font.layout(text).glyphs) total += glyph.advanceWidth;
      return (total * size) / font.unitsPerEm;
    },
    hasGlyph: (cp) =>
      fonts.regular.hasGlyphForCodePoint(cp) &&
      fonts.bold.hasGlyphForCodePoint(cp),
  };
}

export async function renderPdfDocument(
  spec: PdfDocumentSpec,
): Promise<Uint8Array> {
  const { measure, hasGlyph } = createPdfFontMetrics();
  const layout = layoutPdfDocument(spec, measure, hasGlyph);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(sanitize(spec.title, hasGlyph).replace(/\n/g, " "));
  const bytes = loadPdfFonts();
  const regular = await pdf.embedFont(bytes.regular, { subset: true });
  const bold = await pdf.embedFont(bytes.bold, { subset: true });

  let logoImage: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  const logoSpec = spec.header?.logo;
  if (logoSpec && layout.logo) {
    try {
      logoImage =
        logoSpec.kind === "png"
          ? await pdf.embedPng(logoSpec.bytes)
          : await pdf.embedJpg(logoSpec.bytes);
    } catch {
      // An unreadable logo must not block the document.
      logoImage = null;
    }
  }

  const ink = rgb(0.08, 0.08, 0.08);
  const muted = rgb(0.4, 0.4, 0.4);
  layout.pages.forEach((texts, index) => {
    const pdfPage = pdf.addPage([A4.width, A4.height]);
    if (index === 0 && logoImage && layout.logo) {
      const box = layout.logo;
      const scale = Math.min(
        box.width / logoImage.width,
        box.height / logoImage.height,
      );
      const width = logoImage.width * scale;
      const height = logoImage.height * scale;
      pdfPage.drawImage(logoImage, {
        x: box.x + box.width - width,
        y: box.y + box.height - height,
        width,
        height,
      });
    }
    for (const line of layout.lines[index] ?? []) {
      pdfPage.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: line.thickness,
        color: line.light ? rgb(0.8, 0.8, 0.8) : ink,
      });
    }
    for (const text of texts) {
      pdfPage.drawText(text.text, {
        x: text.x,
        y: text.y,
        size: text.size,
        font: text.bold ? bold : regular,
        color: text.muted ? muted : ink,
      });
    }
  });

  return pdf.save({ useObjectStreams: false });
}
