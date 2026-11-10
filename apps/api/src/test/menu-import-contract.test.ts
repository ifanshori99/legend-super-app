// Pure tests for the shared menu import/print contract (beads legend-l8zb,
// legend-az32): the schemas moved out of menu-import.routes.ts keep their wire
// shape, the shared size limit matches the server parser, and a real XLSX
// goes through the server parser (no new dependency).

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MENU_IMPORT_MAX_BASE64_LENGTH,
  MENU_IMPORT_MAX_FILE_BYTES,
  menuImportInputSchema,
  menuImportReportSchema,
  menuPrintQuerySchema,
} from "@starter/shared/menu";
import {
  IMPORT_MAX_FILE_BYTES,
  parseMenuImportFile,
} from "../services/menu-import-parse";

const OUTLET = "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70";
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("menu import contract (shared)", () => {
  it("shares the parser's file size limit", () => {
    expect(MENU_IMPORT_MAX_FILE_BYTES).toBe(IMPORT_MAX_FILE_BYTES);
    expect(MENU_IMPORT_MAX_BASE64_LENGTH).toBe(
      Math.ceil((IMPORT_MAX_FILE_BYTES * 4) / 3) + 4,
    );
  });

  it("accepts csv and xlsx bodies and optional scope fields", () => {
    for (const fileName of ["menu.csv", "menu.xlsx"])
      expect(
        menuImportInputSchema.parse({ fileName, dataBase64: b64("a,b") }),
      ).toMatchObject({ fileName });
    const full = menuImportInputSchema.parse({
      fileName: "menu.csv",
      dataBase64: b64("a,b"),
      outletId: OUTLET,
      channel: "gofood",
      onDuplicate: "update",
    });
    expect(full.channel).toBe("gofood");
  });

  it("refuses tenant fields, unknown keys, bad base64 and bad enums", () => {
    const base = { fileName: "menu.csv", dataBase64: b64("a,b") };
    for (const extra of [
      { tenantId: OUTLET },
      { surprise: 1 },
      { dataBase64: "not base64!" },
      { channel: "bank_transfer" },
      { onDuplicate: "merge" },
    ])
      expect(
        menuImportInputSchema.safeParse({ ...base, ...extra }).success,
      ).toBe(false);
    expect(
      menuImportInputSchema.safeParse({
        ...base,
        dataBase64: "A".repeat(MENU_IMPORT_MAX_BASE64_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("print query is strict with an optional outletId", () => {
    expect(menuPrintQuerySchema.parse({})).toEqual({});
    expect(menuPrintQuerySchema.parse({ outletId: OUTLET })).toEqual({
      outletId: OUTLET,
    });
    expect(menuPrintQuerySchema.safeParse({ outletId: "x" }).success).toBe(
      false,
    );
    expect(menuPrintQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("report schema matches the service report shape", () => {
    const report = {
      fileHash: "a".repeat(64),
      format: "xlsx",
      outletId: OUTLET,
      totalRows: 1,
      validRows: 0,
      errorRows: 1,
      summary: { itemsToCreate: 0, itemsToUpdate: 0, categoriesToCreate: 0 },
      rows: [
        {
          rowNumber: 2,
          action: "error",
          errors: [{ field: "harga", code: "INVALID", message: "Harga salah" }],
        },
      ],
    };
    expect(menuImportReportSchema.parse(report)).toEqual(report);
    expect(
      menuImportReportSchema.safeParse({ ...report, format: "pdf" }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------- XLSX bytes
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe("menu import: XLSX is parsed on the server", () => {
  it("reads a workbook with inline strings via the server parser", () => {
    const cell = (ref: string, v: string | number) =>
      typeof v === "number"
        ? `<c r="${ref}"><v>${v}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    const row = (n: number, values: (string | number)[]) =>
      `<row r="${n}">${values.map((v, i) => cell(`${"ABCDEFGHI"[i]}${n}`, v)).join("")}</row>`;
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(
      1,
      [
        "kategori",
        "nama",
        "deskripsi",
        "tipe",
        "harga",
        "stasiun",
        "course",
        "label",
        "alergen",
      ],
    )}${row(2, [
      "Minuman",
      "Es Teh",
      "Manis",
      "drink",
      15000,
      "Bar",
      "drink",
      "",
      "",
    ])}</sheetData></worksheet>`;
    const bytes = zip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml":
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml": sheet,
    });
    const parsed = parseMenuImportFile({ fileName: "menu.xlsx", bytes });
    expect(parsed.format).toBe("xlsx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].rowNumber).toBe(2);
  });
});
