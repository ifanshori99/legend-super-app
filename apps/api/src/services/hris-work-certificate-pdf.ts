// Work certificate ("Surat Keterangan Kerja") PDF on pdf-lib (WS-10 lifecycle,
// brief 299). Same approach as the PO renderer (purchasing-po-pdf.ts): an
// embedded Noto Sans subset so names are never reduced to `?`, widths measured
// from the font, the creation date is the certificate's issue date and object
// streams are off, so a re-download of the same certificate is byte-identical.
// The text is neutral on purpose: it states employment and dates, never the
// exit type or reason.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type { WorkCertificate } from "@starter/shared/hris";
import { textWidth } from "./purchasing-po-pdf.ts";

export type WorkCertificatePdfInput = WorkCertificate;

const PAGE = { width: 595, height: 842, margin: 64 };
const SIZE = 11;
const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

const FONT_FILES = {
  regular: "NotoSans-Regular-subset.ttf",
  bold: "NotoSans-Bold-subset.ttf",
} as const;
type FontWeight = keyof typeof FONT_FILES;

/** From source the files sit in `assets/fonts/`; the bundle has `dist/fonts/`. */
function fontBytes(weight: FontWeight): Buffer {
  const file = FONT_FILES[weight];
  const candidates = [
    new URL(`./fonts/${file}`, import.meta.url),
    new URL(`../../assets/fonts/${file}`, import.meta.url),
  ];
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`Work certificate font missing: ${file}`);
  return readFileSync(found);
}

const bytesCache = new Map<FontWeight, Buffer>();
function bytesOf(weight: FontWeight): Buffer {
  let bytes = bytesCache.get(weight);
  if (!bytes) {
    bytes = fontBytes(weight);
    bytesCache.set(weight, bytes);
  }
  return bytes;
}

/** Tabs and line breaks print as a space; other control characters vanish. */
function clean(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) out += " ";
    else if (code >= 32 && !(code >= 0x7f && code <= 0x9f)) out += char;
  }
  return out;
}

/** Greedy word wrap; a word longer than the line is cut by character. */
function wrap(
  text: string,
  size: number,
  maxWidth: number,
  bold = false,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of clean(text).split(" ")) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    let rest = word;
    while (
      textWidth(rest, size, bold) > maxWidth &&
      Array.from(rest).length > 1
    ) {
      const chars = Array.from(rest);
      while (
        chars.length > 1 &&
        textWidth(chars.join(""), size, bold) > maxWidth
      )
        chars.pop();
      const head = chars.join("");
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

/** `8 November 2026` from `2026-11-08`. */
export function formatLongDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split("-");
  const name = MONTHS[Number(month) - 1];
  return `${Number(day)} ${name ?? month} ${year}`;
}

/** Issue date (an instant) as a long date in Jakarta time. */
function formatIssuedLong(issuedAt: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(issuedAt));
  return formatLongDate(parts);
}

type Face = "F1" | "F2";

function paginate(
  pdf: PDFDocument,
  fonts: Record<Face, PDFFont>,
  input: WorkCertificatePdfInput,
): void {
  const usable = PAGE.width - PAGE.margin * 2;
  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const ensure = (height: number) => {
    if (y - height < PAGE.margin) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - PAGE.margin;
    }
  };
  const put = (face: Face, size: number, x: number, value: string) => {
    page.drawText(clean(value), {
      x: PAGE.margin + x,
      y,
      size,
      font: fonts[face],
    });
  };
  const centered = (face: Face, size: number, value: string) => {
    ensure(size * 1.5);
    y -= size;
    const width = textWidth(clean(value), size, face === "F2");
    put(face, size, Math.max(0, (usable - width) / 2), value);
    y -= size * 0.5;
  };
  const para = (face: Face, size: number, value: string, x = 0) => {
    for (const piece of wrap(value, size, usable - x, face === "F2")) {
      ensure(size * 1.6);
      y -= size;
      put(face, size, x, piece);
      y -= size * 0.6;
    }
  };
  const field = (label: string, value: string) => {
    const valueX = 130;
    const lines = wrap(value, SIZE, usable - valueX - 8);
    ensure(SIZE * 1.6 * lines.length);
    lines.forEach((piece, index) => {
      y -= SIZE;
      if (index === 0) {
        put("F1", SIZE, 0, label);
        put("F1", SIZE, valueX - 10, ":");
      }
      put("F1", SIZE, valueX, piece);
      y -= SIZE * 0.6;
    });
  };
  const gap = (height: number) => {
    y -= height;
  };

  const { employee } = input;
  centered("F2", 13, input.company.name.toUpperCase());
  gap(6);
  page.drawLine({
    start: { x: PAGE.margin, y },
    end: { x: PAGE.width - PAGE.margin, y },
    thickness: 1,
  });
  gap(18);
  centered("F2", 15, "SURAT KETERANGAN KERJA");
  centered("F1", SIZE, `Nomor: ${input.certificateNo}`);
  gap(18);

  para("F1", SIZE, "Yang bertanda tangan di bawah ini menerangkan bahwa:");
  gap(6);
  field("Nama", employee.fullName);
  field("Nomor karyawan", employee.employeeNo);
  field("Jabatan", input.positionName);
  field("Outlet", input.outletName);
  field("Tanggal bergabung", formatLongDate(input.joinDate));
  field("Hari kerja terakhir", formatLongDate(input.lastWorkingDate));
  gap(10);
  para(
    "F1",
    SIZE,
    `Nama tersebut benar pernah bekerja di ${input.company.name} sejak ` +
      `${formatLongDate(input.joinDate)} sampai dengan ` +
      `${formatLongDate(input.lastWorkingDate)}.`,
  );
  gap(4);
  para(
    "F1",
    SIZE,
    "Surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya.",
  );
  gap(28);

  ensure(SIZE * 1.6 * 7);
  para("F1", SIZE, `Diterbitkan pada ${formatIssuedLong(input.issuedAt)}`);
  gap(4);
  para("F1", SIZE, input.company.name);
  gap(52);
  para("F2", SIZE, input.managerName ?? "Bagian SDM");
  if (input.managerName) para("F1", SIZE, "Atasan langsung");
}

/** A complete PDF file for one work certificate; starts with `%PDF-`. */
export async function renderWorkCertificatePdf(
  input: WorkCertificatePdfInput,
): Promise<Buffer> {
  const issued = new Date(input.issuedAt);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Surat Keterangan Kerja ${input.certificateNo}`);
  pdf.setProducer("Legend");
  pdf.setCreator("Legend");
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);
  const fonts = {
    F1: await pdf.embedFont(bytesOf("regular"), { subset: true }),
    F2: await pdf.embedFont(bytesOf("bold"), { subset: true }),
  };
  paginate(pdf, fonts, input);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
