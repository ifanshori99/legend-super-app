// Pure unit tests of the payroll export format layer (bead legend-34qx, brief
// docs/briefs/ws10-payroll-bank-coretax.md slices A and B). Expected values come
// from the brief: bank CSV layout (header, CRLF, RFC 4180, formula-injection
// prefix, account number always quoted) and the DJP Coretax BPMP sample
// (element order, tabs, `Rate` = terRateBp / 100 without trailing zeros).
//
// Interfaces under test (brief slices A/B; none of the modules exist yet, so
// every test here fails first on the missing import):
//   lib/payroll-export/bank-formats.ts
//     getBankFormatter(format): BankFormatter   // generic_csv only
//     BankFormatter { format; contentType; extension; render(rows, meta): string }
//   lib/payroll-export/coretax-bpmp.ts
//     buildBpmpXml({ withholderTin16, nitku22, rows }): string
//     formatTerRate(bp): string
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - `contentType` starts with `text/csv`; `extension` is `csv` (a leading dot
//   is tolerated). BPMP XML line ends are LF; CRLF is tolerated and a trailing
//   newline after `</MmPayrollBulk>` is tolerated (compare after trimEnd).
// - The `reference` CSV column content is unspecified: only the column count is
//   asserted. Non-integer / non-finite amounts make `render` throw (integer
//   IDR, "no new rounding": it must never round silently).
// - Position longer than 50 chars is truncated to a 50 char prefix (brief:
//   "max 50 chars", marked unconfirmed there). Control characters illegal in
//   XML 1.0 are either rejected (throw) or removed, never written.
// - Invalid input to `formatTerRate` (negative, fractional, NaN) throws.
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import {
  getBankFormatter,
  type BankFileMeta,
  type BankFileRow,
} from "../lib/payroll-export/bank-formats.ts";
import {
  buildBpmpXml,
  formatTerRate,
  type BpmpRow,
} from "../lib/payroll-export/coretax-bpmp.ts";

// ---- Bank CSV (slice A) -------------------------------------------------------

const META: BankFileMeta = {
  payrollRunId: "0f9d3c1e-6c3a-4a3e-9d57-7a1b2c3d4e5f",
  periodLabel: "2025-10",
  payDate: "2025-10-25",
};
const HEADER =
  "no,employee_code,employee_name,bank_name,account_number,account_holder,amount_idr,reference";

function bankRow(over: Partial<BankFileRow> = {}): BankFileRow {
  return {
    employeeId: "11111111-1111-4111-8111-111111111111",
    employeeCode: "E001",
    employeeName: "Budi Santoso",
    bankName: "BCA",
    accountNumber: "1234567890",
    accountHolder: "Budi Santoso",
    amountIdr: 4_250_000,
    ...over,
  };
}

const generic = () => getBankFormatter("generic_csv");
const render = (rows: BankFileRow[]) => generic().render(rows, META);

/** RFC 4180 reader (quoted cells, doubled quotes, CRLF inside quotes kept). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

describe("bank formatter registry", () => {
  it("[bank-format-generic-meta] generic_csv is a CSV formatter named after its format", () => {
    const formatter = generic();
    expect(formatter.format).toBe("generic_csv");
    expect(formatter.contentType).toMatch(/^text\/csv/);
    expect(formatter.extension).toMatch(/^\.?csv$/);
    expect(typeof formatter.render).toBe("function");
  });

  it("[bank-format-unsupported] mandiri, bni and bjb throw HttpError 422 PAYROLL_BANK_FORMAT_NOT_SUPPORTED (no guessed layout; bca is supported since legend-648)", () => {
    for (const format of ["mandiri", "bni", "bjb"] as const) {
      let error: unknown;
      try {
        getBankFormatter(format);
      } catch (caught) {
        error = caught;
      }
      expect(error, format).toBeInstanceOf(HttpError);
      expect((error as HttpError).status, format).toBe(422);
      expect((error as HttpError).code, format).toBe(
        "PAYROLL_BANK_FORMAT_NOT_SUPPORTED",
      );
    }
  });

  it("[bank-format-unknown] an unknown format never yields a formatter", () => {
    expect(() => getBankFormatter("not-a-bank" as never)).toThrow();
  });
});

describe("generic_csv rendering", () => {
  it("[bank-csv-layout] header row, CRLF line ends, UTF-8 without BOM, no trailing line, 1-based `no`", () => {
    const text = render([
      bankRow(),
      bankRow({
        employeeCode: "E002",
        accountNumber: "9876543210",
        amountIdr: 1_000_000,
      }),
    ]);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADER);
    // No bare LF or CR anywhere outside the CRLF separators.
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    // No trailing empty line.
    expect(text.endsWith("\r\n")).toBe(false);
    expect(lines[2]).not.toBe("");
    const cells = parseCsv(text);
    expect(cells[1]![0]).toBe("1");
    expect(cells[2]![0]).toBe("2");
    for (const row of cells) expect(row).toHaveLength(8);
  });

  it("[bank-csv-cells] each row maps employee code, name, bank, account, holder and the plain integer amount", () => {
    const [, row] = parseCsv(render([bankRow()]));
    expect(row!.slice(1, 7)).toEqual([
      "E001",
      "Budi Santoso",
      "BCA",
      "1234567890",
      "Budi Santoso",
      "4250000",
    ]);
  });

  it("[bank-csv-account-quoted] account_number is always a quoted text cell, even all digits", () => {
    const line = render([bankRow({ accountNumber: "0012345678" })]).split(
      "\r\n",
    )[1]!;
    expect(line).toContain(',"0012345678",');
    // Leading zeros survive the round trip.
    expect(parseCsv(line)[0]![4]).toBe("0012345678");
  });

  it("[bank-csv-null-bank] a null bank name is an empty cell", () => {
    const [, row] = parseCsv(render([bankRow({ bankName: null })]));
    expect(row).toHaveLength(8);
    expect(row![3]).toBe("");
  });

  it("[bank-csv-quoting] commas, double quotes and line breaks are RFC 4180 quoted and round-trip", () => {
    const tricky = [
      `Siti "Cici", S.Kom`,
      "Line\r\nBreak",
      "Only,comma",
      'Quote"inside',
    ];
    const rows = tricky.map((name, index) =>
      bankRow({
        employeeCode: `Q${index}`,
        employeeName: name,
        accountHolder: name,
        accountNumber: `55500000${index}`,
      }),
    );
    const text = render(rows);
    expect(text).toContain(`"Siti ""Cici"", S.Kom"`);
    const parsed = parseCsv(text).slice(1);
    expect(parsed).toHaveLength(tricky.length);
    parsed.forEach((cells, index) => {
      expect(cells).toHaveLength(8);
      expect(cells[2]).toBe(tricky[index]);
      expect(cells[5]).toBe(tricky[index]);
    });
  });

  it("[bank-csv-injection] a text cell starting with = + - @ TAB or CR gets a leading apostrophe", () => {
    const dangerous = [
      "=SUM(A1)",
      "+628123",
      "-1+1",
      "@cmd",
      "\tTab",
      "\rCarriage",
    ];
    const rows = dangerous.map((value, index) =>
      bankRow({
        employeeCode: value,
        employeeName: value,
        bankName: value,
        accountHolder: value,
        accountNumber: `70000000${index}`,
      }),
    );
    const parsed = parseCsv(render(rows)).slice(1);
    expect(parsed).toHaveLength(dangerous.length);
    parsed.forEach((cells, index) => {
      const expected = `'${dangerous[index]}`;
      expect(cells[1], "employee_code").toBe(expected);
      expect(cells[2], "employee_name").toBe(expected);
      expect(cells[3], "bank_name").toBe(expected);
      expect(cells[5], "account_holder").toBe(expected);
    });
  });

  it("[bank-csv-injection-account] an account number that starts with a dangerous character is also neutralised", () => {
    const [, cells] = parseCsv(
      render([bankRow({ accountNumber: "+62812345" })]),
    );
    expect(cells![4]).toBe("'+62812345");
  });

  it("[bank-csv-safe-untouched] harmless text is not altered (no apostrophe on normal names, safe middle characters)", () => {
    const [, cells] = parseCsv(
      render([
        bankRow({
          employeeName: "Ani = Budi + Co @ Home",
          employeeCode: "A-1",
        }),
      ]),
    );
    expect(cells![1]).toBe("A-1");
    expect(cells![2]).toBe("Ani = Budi + Co @ Home");
  });

  it("[bank-csv-unicode] non-ASCII names pass through unchanged", () => {
    const name = "Ni Luh Putu Ayu Çelik 张伟";
    const [, cells] = parseCsv(render([bankRow({ employeeName: name })]));
    expect(cells![2]).toBe(name);
  });

  it("[bank-csv-totals] one data row per input row and the amount cells add up to the input total", () => {
    const amounts = [
      4_250_000, 3_100_500, 5_000_001, 1_000_000, 1_234_567_890_123,
    ];
    const rows = amounts.map((amountIdr, index) =>
      bankRow({
        employeeCode: `T${index}`,
        accountNumber: `80000000${index}`,
        amountIdr,
      }),
    );
    const parsed = parseCsv(render(rows));
    expect(parsed).toHaveLength(amounts.length + 1); // header + rows, no footer
    const cells = parsed.slice(1).map((row) => row[6]!);
    // Plain digits: no grouping, decimals or exponent.
    for (const cell of cells) expect(cell).toMatch(/^[1-9]\d*$/);
    expect(cells.map(Number)).toEqual(amounts);
    expect(cells.reduce((sum, cell) => sum + Number(cell), 0)).toBe(
      amounts.reduce((sum, value) => sum + value, 0),
    );
  });

  it("[bank-csv-no-rounding] a fractional or non-finite amount throws instead of being rounded", () => {
    expect(() => render([bankRow({ amountIdr: 100.5 })])).toThrow();
    expect(() => render([bankRow({ amountIdr: Number.NaN })])).toThrow();
    expect(() =>
      render([bankRow({ amountIdr: Number.POSITIVE_INFINITY })]),
    ).toThrow();
  });

  it("[bank-csv-deterministic] same input renders the same bytes", () => {
    const rows = [
      bankRow(),
      bankRow({ employeeCode: "E002", accountNumber: "222222222" }),
    ];
    expect(render(rows)).toBe(render(rows));
  });
});

// ---- Coretax BPMP XML (slice B) -----------------------------------------------

const TIN = "0029482015507000";
const NITKU = "0029482015507000000000";

function bpmpRow(over: Partial<BpmpRow> = {}): BpmpRow {
  return {
    taxMonth: 10,
    taxYear: 2024,
    nik16: "3275010905770021",
    ptkpStatus: "TK/0",
    position: "Sifu",
    grossIdr: 40_000_000,
    terRateBp: 1600,
    withholdingDate: "2024-10-21",
    ...over,
  };
}

/** Hand-written expectation of the DJP sample layout (tabs, element order). */
function expectedXml(rows: Array<Parameters<typeof expectedBlock>[0]>): string {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<MmPayrollBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `\t<TIN>${TIN}</TIN>`,
    `\t<ListOfMmPayroll>`,
    ...rows.map(expectedBlock),
    `\t</ListOfMmPayroll>`,
    `</MmPayrollBulk>`,
  ].join("\n");
}
function expectedBlock(r: {
  month: string;
  year: string;
  nik: string;
  ptkp: string;
  position: string;
  gross: string;
  rate: string;
  date: string;
}): string {
  return [
    `\t\t<MmPayroll>`,
    `\t\t\t<TaxPeriodMonth>${r.month}</TaxPeriodMonth>`,
    `\t\t\t<TaxPeriodYear>${r.year}</TaxPeriodYear>`,
    `\t\t\t<CounterpartOpt>Resident</CounterpartOpt>`,
    `\t\t\t<CounterpartPassport xsi:nil="true"/>`,
    `\t\t\t<CounterpartTin>${r.nik}</CounterpartTin>`,
    `\t\t\t<StatusTaxExemption>${r.ptkp}</StatusTaxExemption>`,
    `\t\t\t<Position>${r.position}</Position>`,
    `\t\t\t<TaxCertificate>N/A</TaxCertificate>`,
    `\t\t\t<TaxObjectCode>21-100-01</TaxObjectCode>`,
    `\t\t\t<Gross>${r.gross}</Gross>`,
    `\t\t\t<Rate>${r.rate}</Rate>`,
    `\t\t\t<IDPlaceOfBusinessActivity>${NITKU}</IDPlaceOfBusinessActivity>`,
    `\t\t\t<WithholdingDate>${r.date}</WithholdingDate>`,
    `\t\t</MmPayroll>`,
  ].join("\n");
}

const normalise = (xml: string) => xml.replace(/\r\n/g, "\n").trimEnd();
const build = (
  rows: BpmpRow[],
  over: { withholderTin16?: string; nitku22?: string } = {},
) => buildBpmpXml({ withholderTin16: TIN, nitku22: NITKU, rows, ...over });

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, "&");
const positionOf = (xml: string) =>
  unescapeXml(/<Position>([\s\S]*?)<\/Position>/.exec(xml)![1]!);

describe("formatTerRate", () => {
  it("[bpmp-rate-format] basis points become a dot-decimal percent without trailing zeros", () => {
    const cases: Array<[number, string]> = [
      [1600, "16"],
      [175, "1.75"],
      [25, "0.25"],
      [5, "0.05"],
      [150, "1.5"],
      [3450, "34.5"],
      [3400, "34"],
      [1000, "10"],
      [100, "1"],
      [0, "0"],
    ];
    for (const [bp, text] of cases)
      expect(formatTerRate(bp), String(bp)).toBe(text);
  });

  it("[bpmp-rate-invalid] negative, fractional or non-finite basis points throw", () => {
    for (const bp of [-1, 0.5, 12.34, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => formatTerRate(bp), String(bp)).toThrow();
  });
});

describe("buildBpmpXml", () => {
  it("[bpmp-xml-exact] one employee renders exactly the DJP sample: declaration, root, element order, tabs, values", () => {
    const xml = build([bpmpRow()]);
    expect(normalise(xml)).toBe(
      expectedXml([
        {
          month: "10",
          year: "2024",
          nik: "3275010905770021",
          ptkp: "TK/0",
          position: "Sifu",
          gross: "40000000",
          rate: "16",
          date: "2024-10-21",
        },
      ]),
    );
    // Tabs, not spaces, indent the elements.
    expect(xml).toContain("\n\t\t\t<TaxPeriodMonth>10</TaxPeriodMonth>");
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'),
    ).toBe(true);
  });

  it("[bpmp-xml-rows] several employees keep the given row order; month has no leading zero; fractional rate and PTKP render", () => {
    const xml = build([
      bpmpRow({
        taxMonth: 3,
        ptkpStatus: "K/1",
        grossIdr: 10_000_000,
        terRateBp: 175,
        withholdingDate: "2025-03-21",
        taxYear: 2025,
      }),
      bpmpRow({
        taxMonth: 3,
        taxYear: 2025,
        nik16: "3175091507900003",
        position: "Barista",
        grossIdr: 5_000_000,
        terRateBp: 25,
        withholdingDate: "2025-03-21",
      }),
    ]);
    expect(normalise(xml)).toBe(
      expectedXml([
        {
          month: "3",
          year: "2025",
          nik: "3275010905770021",
          ptkp: "K/1",
          position: "Sifu",
          gross: "10000000",
          rate: "1.75",
          date: "2025-03-21",
        },
        {
          month: "3",
          year: "2025",
          nik: "3175091507900003",
          ptkp: "TK/0",
          position: "Barista",
          gross: "5000000",
          rate: "0.25",
          date: "2025-03-21",
        },
      ]),
    );
    expect(xml.match(/<MmPayroll>/g)).toHaveLength(2);
  });

  it("[bpmp-xml-escaping] reserved characters in the position are escaped and round-trip", () => {
    const position = `R&D <Lead> "Chef" 'x'`;
    const xml = build([bpmpRow({ position })]);
    // Raw reserved characters never appear inside the element text.
    const raw = /<Position>([\s\S]*?)<\/Position>/.exec(xml)![1]!;
    expect(raw).not.toMatch(/[<>]/);
    expect(raw).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
    expect(raw).toContain("&amp;");
    expect(raw).toContain("&lt;Lead");
    expect(positionOf(xml)).toBe(position);
  });

  it("[bpmp-xml-no-element-injection] markup in the position cannot add or close elements", () => {
    const xml = build([
      bpmpRow({ position: "</Position><Gross>1</Gross><Position>x" }),
    ]);
    expect(xml.match(/<Gross>/g)).toHaveLength(1);
    expect(xml.match(/<Position>/g)).toHaveLength(1);
    expect(xml.match(/<\/Position>/g)).toHaveLength(1);
    expect(xml).toContain("<Gross>40000000</Gross>");
  });

  it("[bpmp-xml-control-chars] characters illegal in XML 1.0 are rejected or removed, never written", () => {
    let xml: string | undefined;
    try {
      xml = build([bpmpRow({ position: "Bar\u0000ista\u0008\u001f" })]);
    } catch {
      return; // rejecting is fine
    }
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("[bpmp-xml-position-length] a position over 50 characters is cut to a 50 character prefix", () => {
    const position =
      "Kepala Bagian Operasional Gerai dan Pengembangan Menu Nusantara Timur";
    const out = positionOf(build([bpmpRow({ position })]));
    expect(out.length).toBeLessThanOrEqual(50);
    expect(position.startsWith(out)).toBe(true);
    expect(out.length).toBeGreaterThan(40);
  });

  it("[bpmp-xml-digits] withholder TIN, NITKU and NIK must be digit strings of exactly 16, 22 and 16", () => {
    const badTin = [
      "002948201550700",
      "00294820155070000",
      "0029482015507abc",
      "00.294.820.1-550.7000",
      "",
    ];
    for (const withholderTin16 of badTin)
      expect(
        () => build([bpmpRow()], { withholderTin16 }),
        `TIN ${withholderTin16}`,
      ).toThrow();
    const badNitku = [
      "002948201550700000000",
      "00294820155070000000000",
      "002948201550700000000x",
      "",
    ];
    for (const nitku22 of badNitku)
      expect(
        () => build([bpmpRow()], { nitku22 }),
        `NITKU ${nitku22}`,
      ).toThrow();
    const badNik = [
      "327501090577002",
      "32750109057700211",
      "3275010905770O21",
      "3275 0109 0577 0021",
      "",
    ];
    for (const nik16 of badNik)
      expect(() => build([bpmpRow({ nik16 })]), `NIK ${nik16}`).toThrow();
  });

  it("[bpmp-xml-field-validation] month 1-12, 4-digit year, integer non-negative gross, valid PTKP and date, else throw", () => {
    const bad: Array<[string, Partial<BpmpRow>]> = [
      ["month 0", { taxMonth: 0 }],
      ["month 13", { taxMonth: 13 }],
      ["month fractional", { taxMonth: 1.5 }],
      ["year 99", { taxYear: 99 }],
      ["year 10000", { taxYear: 10_000 }],
      ["gross negative", { grossIdr: -1 }],
      ["gross fractional", { grossIdr: 1000.5 }],
      ["gross NaN", { grossIdr: Number.NaN }],
      ["rate negative", { terRateBp: -1 }],
      ["rate fractional", { terRateBp: 1.5 }],
      ["ptkp unknown", { ptkpStatus: "TK/9" as never }],
      ["ptkp empty", { ptkpStatus: "" as never }],
      ["date dd-mm-yyyy", { withholdingDate: "21-10-2024" }],
      ["date month 13", { withholdingDate: "2024-13-01" }],
      ["date day 32", { withholdingDate: "2024-10-32" }],
      ["date with time", { withholdingDate: "2024-10-21T00:00:00Z" }],
    ];
    for (const [label, over] of bad)
      expect(() => build([bpmpRow(over)]), label).toThrow();
  });

  it("[bpmp-xml-ptkp-all] every PTKP status of the sample range is accepted and written verbatim", () => {
    for (const ptkpStatus of [
      "TK/0",
      "TK/1",
      "TK/2",
      "TK/3",
      "K/0",
      "K/1",
      "K/2",
      "K/3",
    ] as const) {
      const xml = build([bpmpRow({ ptkpStatus })]);
      expect(xml).toContain(
        `<StatusTaxExemption>${ptkpStatus}</StatusTaxExemption>`,
      );
    }
  });

  it("[bpmp-xml-fixed-values] resident, nil passport, no certificate and the permanent-employee object code are constant", () => {
    const xml = build([bpmpRow(), bpmpRow({ nik16: "3175091507900003" })]);
    expect(
      xml.match(/<CounterpartOpt>Resident<\/CounterpartOpt>/g),
    ).toHaveLength(2);
    expect(xml.match(/<CounterpartPassport xsi:nil="true"\/>/g)).toHaveLength(
      2,
    );
    expect(xml.match(/<TaxCertificate>N\/A<\/TaxCertificate>/g)).toHaveLength(
      2,
    );
    expect(
      xml.match(/<TaxObjectCode>21-100-01<\/TaxObjectCode>/g),
    ).toHaveLength(2);
    expect(
      xml.match(
        new RegExp(
          `<IDPlaceOfBusinessActivity>${NITKU}</IDPlaceOfBusinessActivity>`,
          "g",
        ),
      ),
    ).toHaveLength(2);
    expect(xml.match(/<TIN>/g)).toHaveLength(1);
  });
});
