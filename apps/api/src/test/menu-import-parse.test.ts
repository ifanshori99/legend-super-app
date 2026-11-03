// Pure (no database) tests for the bulk-import parser (bead legend-dmi; PRD
// v1.7 §3 F8 "Impor Massal"): CSV + XLSX parsing, strict row validation with
// row numbers, formula / CSV-injection refusal, size and row limits.

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  csvSafeCell,
  IMPORT_MAX_ROWS,
  ImportFileError,
  parseMenuImportFile,
  parsePriceIdr,
} from "../services/menu-import-parse";

const HEADER =
  "kategori,nama,deskripsi,tipe,harga,stasiun,course,label,alergen";
const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join("\n"));
const parse = (bytes: Buffer, fileName = "menu.csv") =>
  parseMenuImportFile({ fileName, bytes });

/** Minimal zip writer (stored or deflated) for building XLSX fixtures. */
function zip(files: Record<string, string>, deflate = false): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

function xlsx(rows: string[][], extra: { formulaAt?: string } = {}): Buffer {
  const strings: string[] = [];
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          if (ref === extra.formulaAt)
            return `<c r="${ref}"><f>SUM(1,2)</f><v>3</v></c>`;
          if (/^\d+$/.test(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          strings.push(value);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return zip(
    {
      "xl/workbook.xml": `<workbook><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
    true,
  );
}

describe("menu import parser (WS-03 F8 Impor Massal)", () => {
  it("parses a valid CSV into strict rows with defaults", () => {
    const result = parse(
      csv(
        "Minuman,Kopi Susu,Es kopi,single,25000,Bar,,manis|dingin,susu",
        "Makanan,Nasi Goreng,,,Rp 32.000,Dapur,main,,",
      ),
    );
    expect(result.format).toBe("csv");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ rowNumber: 2, errors: [] });
    expect(result.rows[0].data).toMatchObject({
      name: "Kopi Susu",
      priceIdr: 25000,
      labels: ["manis", "dingin"],
      allergens: ["susu"],
    });
    expect(result.rows[1].data).toMatchObject({
      type: "single",
      priceIdr: 32000,
      course: "main",
    });
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports bad rows with their spreadsheet row number", () => {
    const result = parse(
      csv(
        "Minuman,Ok,,,10000,Bar,,,",
        ",Tanpa Kategori,,,10000,Bar,,,",
        "Minuman,Harga Desimal,,,10.5,Bar,,,",
        "Minuman,Tipe Salah,,paketan,10000,Bar,,,",
        "Minuman,Tanpa Stasiun,,,10000,,,,",
      ),
    );
    const bad = result.rows.filter((r) => r.errors.length > 0);
    expect(bad.map((r) => r.rowNumber)).toEqual([3, 4, 5, 6]);
    expect(bad[0].errors[0]).toMatchObject({
      field: "category",
      code: "REQUIRED",
    });
    expect(bad[1].errors[0]).toMatchObject({
      field: "priceIdr",
      code: "INVALID",
    });
    expect(bad[2].errors[0].field).toBe("type");
    expect(bad[3].errors[0].field).toBe("station");
    expect(result.rows[0].data).not.toBeNull();
  });

  it("flags duplicate category+name inside the file (case-insensitive)", () => {
    const result = parse(
      csv("Minuman,Teh,,,5000,Bar,,,", "minuman, TEH ,,,6000,Bar,,,"),
    );
    expect(result.rows[1].errors[0]).toMatchObject({
      code: "DUPLICATE_IN_FILE",
    });
    expect(result.rows[1].errors[0].message).toContain("baris 2");
  });

  it("refuses formula / CSV-injection cells instead of storing them", () => {
    const result = parse(
      csv(
        'Minuman,"=HYPERLINK(""http://x"")",,,5000,Bar,,,',
        "Minuman,+cmd,,,5000,Bar,,,",
        "Minuman,@SUM(A1),,,5000,Bar,,,",
        "Minuman,-1+1,,,5000,Bar,,,",
        "Minuman,Aman,=1+1,,5000,Bar,,,",
      ),
    );
    for (const row of result.rows)
      expect(row.errors[0].code).toBe("FORMULA_NOT_ALLOWED");
    expect(csvSafeCell("=1+1")).toBe("'=1+1");
    expect(csvSafeCell("Kopi")).toBe("Kopi");
  });

  it("handles quoted commas, BOM and semicolon delimiters", () => {
    const quoted = parse(
      Buffer.from(
        `\uFEFF${HEADER}\nMinuman,"Kopi, Susu","Es ""dingin""",,5000,Bar,,,\n`,
      ),
    );
    expect(quoted.rows[0].data?.name).toBe("Kopi, Susu");
    expect(quoted.rows[0].data?.description).toBe('Es "dingin"');
    const semi = parse(
      Buffer.from(
        HEADER.replaceAll(",", ";") + "\nMinuman;Teh;;;5000;Bar;;;\n",
      ),
    );
    expect(semi.rows[0].data?.name).toBe("Teh");
  });

  it("parses prices in rupiah formats and refuses decimals", () => {
    expect(parsePriceIdr("25000")).toBe(25000);
    expect(parsePriceIdr("Rp 25.000")).toBe(25000);
    expect(parsePriceIdr("1,250,000")).toBe(1250000);
    expect(parsePriceIdr("25000.0")).toBe(25000);
    expect(parsePriceIdr("25.5")).toBeNull();
    expect(parsePriceIdr("-5")).toBeNull();
    expect(parsePriceIdr("")).toBeNull();
  });

  it("refuses a missing required header column", () => {
    expect(() => parse(Buffer.from("kategori,nama\nA,B\n"))).toThrowError(
      expect.objectContaining({ code: "HEADER_MISSING" }),
    );
  });

  it("enforces size and row limits", () => {
    expect(() => parse(Buffer.alloc(0))).toThrowError(ImportFileError);
    expect(() => parse(Buffer.alloc(1024 * 1024 + 1, 97))).toThrowError(
      expect.objectContaining({ code: "FILE_TOO_LARGE" }),
    );
    const many = Array.from(
      { length: IMPORT_MAX_ROWS + 1 },
      (_, i) => `K,Item ${i},,,1000,Bar,,,`,
    );
    expect(() => parse(csv(...many))).toThrowError(
      expect.objectContaining({ code: "TOO_MANY_ROWS" }),
    );
    expect(() => parse(csv("K,Item,,,1000,Bar,,,"), "menu.txt")).toThrowError(
      expect.objectContaining({ code: "FILE_UNSUPPORTED" }),
    );
  });

  it("parses an XLSX workbook (shared strings, numbers, deflate)", () => {
    const result = parse(
      xlsx([
        ["Kategori", "Nama", "Harga", "Stasiun"],
        ["Minuman", "Teh & Madu", "15000", "Bar"],
      ]),
      "menu.xlsx",
    );
    expect(result.format).toBe("xlsx");
    expect(result.rows[0].data).toMatchObject({
      name: "Teh & Madu",
      priceIdr: 15000,
      station: "Bar",
    });
  });

  it("never evaluates XLSX formulas: a formula cell is a row error", () => {
    const result = parse(
      xlsx(
        [
          ["Kategori", "Nama", "Harga", "Stasiun"],
          ["Minuman", "Teh", "15000", "Bar"],
        ],
        { formulaAt: "B2" },
      ),
      "menu.xlsx",
    );
    expect(result.rows[0].errors[0]).toMatchObject({
      field: "name",
      code: "FORMULA_NOT_ALLOWED",
    });
  });

  it("refuses a zip bomb and XML entity declarations", () => {
    const bomb = zip(
      {
        "xl/worksheets/sheet1.xml": "A".repeat(9 * 1024 * 1024),
      },
      true,
    );
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => parse(bomb, "menu.xlsx")).toThrowError(
      expect.objectContaining({ code: "FILE_TOO_LARGE" }),
    );
    const xxe = zip({
      "xl/worksheets/sheet1.xml": `<!DOCTYPE x [<!ENTITY a "b">]><worksheet/>`,
    });
    expect(() => parse(xxe, "menu.xlsx")).toThrowError(
      expect.objectContaining({ code: "FILE_UNSUPPORTED" }),
    );
  });

  it("refuses a file whose content does not match its extension", () => {
    expect(() => parse(Buffer.from("not a zip"), "menu.xlsx")).toThrowError(
      expect.objectContaining({ code: "FILE_UNSUPPORTED" }),
    );
  });
});
