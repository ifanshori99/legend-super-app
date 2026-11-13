# Brief WS-10: payroll bank transfer file + Coretax PPh 21 export (legend-34qx)

Branch `ws/payroll-bank-coretax` (worktree root = repo root of this checkout), base `milestone/m1`.
Card: `bd show legend-34qx`. PRD: `docs/PRD.md` §3 D.30 "Pembayaran Gaji", "Dokumen Pajak"; §6 H `payslips`.
Existing contract: `packages/shared/src/hris/payroll/payslips.ts` (`BANK_TRANSFER_FORMATS`, `bankTransferFileSchema`,
`assertBankFileMatchesRun` = PAYR-04, tax export kinds `monthly_withholding|annual_statement`).
DB: `apps/api/src/db/schema/payroll.ts`. Existing tests: `apps/api/src/test/payroll-core-db.test.ts`.

## Rules (non-negotiable)

1. Export reads ONLY a locked payroll run (run lock / final state). Never changes any amount. Unlocked run -> 409.
2. Bank file: rows = exactly the run's `bank_transfer` payslips with net > 0; sum(rows) == run `bankTransferIdr`;
   per-employee amount == payslip net (bank portion). Call `assertBankFileMatchesRun` before writing; mismatch -> refuse.
   Integer IDR, no new rounding (use the payroll rounding already applied to payslips).
3. Coretax PPh 21: values come from payslip/run tax fields already computed; no recomputation of tax.
4. PII (bank account no., account name, NPWP, NIK): only users with payroll permission (existing payroll
   export/read permission in `packages/shared/src/permissions.ts`; reuse, do not invent a weaker one).
   Never log PII (no logger calls with rows/file content). Audit the export event without PII.
5. Bank formats: `generic_csv` implemented fully. `bca|mandiri|bni|bjb`: format layer (registry of
   `BankFormatter` per format) so banks can be added; unconfirmed banks -> explicit 422/`format_not_supported`
   (do NOT guess a bank layout). CSV injection safe (prefix `= + - @ \t \r` cells with `'`), RFC 4180 quoting.
6. Coretax: build the DJP Coretax PPh 21 import (BPMP / bulanan, A1 tahunan) per spec in this file section
   "Coretax spec" (filled by lead). Unknown fields -> documented assumption, not invented data.
7. Migrations only in range `0453`-`0455` (likely none needed). `db:generate` must be empty after.
8. Tests via `heavy env LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` (only the one heavy-token holder).

## Facts (from Explore)

- Endpoints exist in `packages/shared/src/hris/payroll/endpoints.ts:409-433` (`createBankTransferFile` POST
  `/runs/:payrollRunId/bank-transfer-files`, `listBankTransferFiles`, `createPayrollTaxExport` POST `/tax-exports`).
  Read perm `payroll.view`; create bank file + tax export perm `payroll.lock` (endpoints.ts:13, contract wins). No service/route uses them yet.
- Tables `bank_transfer_files` (`apps/api/src/db/schema/payroll.ts:566`, objectKey NOT NULL, insert trigger requires
  run status `locked|paid`, UPDATE revoked) and `payroll_tax_exports` (:605). No migration needed.
- Run: `payrollRuns` status `locked|paid` = exportable; `periodStart/periodEnd/payDate`, `legalEntityId`.
- Payslip amounts are in sealed `calculationEncrypted` (open with `openPayrollValue`, `apps/api/src/lib/payroll-sealed.ts:135`).
  Tax object `payslipTaxSchema` (payslips.ts:82): `method` ter|annual_recalculation, `terRateBp`, `taxableGrossIdr`, `pph21Idr`, `ptkpStatus`.
- PII on `employees` (`apps/api/src/db/schema/hris.ts:199`): `nikEncrypted`, `npwpEncrypted`, `bankAccountEncrypted`
  (open with `openHrisPii`, `apps/api/src/lib/hris-pii.ts:214`). Legal entity NPWP: `legal_entities.npwpEncrypted`
  (`apps/api/src/db/schema/platform-org.ts:176`). No NITKU column anywhere.
- Storage: `uploadStorage`, `signedStorageUrl` in `apps/api/src/services/core-storage.ts`. Audit: `recordAudit`
  (`apps/api/src/services/core-audit.ts:73`). Access: `assertPayrollTenantCan` (`apps/api/src/services/payroll-access.ts`).
  Route pattern: `apps/api/src/routes/payroll-statutory.routes.ts`. XML escape precedent: `apps/api/src/services/accounting-coretax-xml.ts`.

## Coretax spec (official DJP sample `bpmp.zip`, pajak.go.id/en/node/112031, BPMP template 2024-12 / converter v3 2025-04)

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<MmPayrollBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <TIN>0029482015507000</TIN>                       <!-- withholder NPWP, 16 digits -->
  <ListOfMmPayroll>
    <MmPayroll>
      <TaxPeriodMonth>10</TaxPeriodMonth>            <!-- 1..12, no leading zero -->
      <TaxPeriodYear>2024</TaxPeriodYear>
      <CounterpartOpt>Resident</CounterpartOpt>      <!-- Resident | Foreign -->
      <CounterpartPassport xsi:nil="true"/>
      <CounterpartTin>3275010905770021</CounterpartTin>  <!-- employee NIK (16 digits) -->
      <StatusTaxExemption>TK/0</StatusTaxExemption>  <!-- PTKP: TK/0..K/3 -->
      <Position>Sifu</Position>
      <TaxCertificate>N/A</TaxCertificate>           <!-- N/A | DTP | ETC ... ; we always emit N/A -->
      <TaxObjectCode>21-100-01</TaxObjectCode>       <!-- pegawai tetap -->
      <Gross>40000000</Gross>                        <!-- integer IDR -->
      <Rate>16</Rate>                                <!-- TER percent -->
      <IDPlaceOfBusinessActivity>0029482015507000000000</IDPlaceOfBusinessActivity> <!-- NITKU 22 -->
      <WithholdingDate>2024-10-21</WithholdingDate>  <!-- YYYY-MM-DD -->
    </MmPayroll>
  </ListOfMmPayroll>
</MmPayrollBulk>
```

Decisions / assumptions (record in report):
- One `<MmPayroll>` per employee per tax month, from payslips of runs with status `locked|paid`, same `legalEntityId`,
  `payDate` in the month, `tax.method === "ter"` only. `annual_recalculation` slips (Dec / last period) belong to A1 -> excluded.
- Only permanent employees (pegawai tetap; employmentType mapping decided by implementer from `employmentTypeSchema`,
  `packages/shared/src/hris/organization.ts:113`); others are BP21 (out of scope) -> excluded, counted in summary.
- Several TER slips for one employee in a month: Gross = sum `taxableGrossIdr`; all slips must carry the TER rate of the
  combined gross (re-derive with the existing TER table/rounding function); otherwise refuse 422 (never guess).
- Tax-consistency guard: the existing engine rounding of `Gross x Rate` must equal the summed `pph21Idr`; mismatch -> refuse 422.
- Rate = `terRateBp / 100`, dot decimal, no trailing zeros ("16", "1.75", "0.25"). Decimal format is an assumption (sample shows integers only).
- CounterpartTin = NIK (16 digits); missing/invalid NIK -> refuse 422 listing employee IDs (not NIKs).
- TIN = legal entity NPWP (16 digits; 15-digit legacy -> refuse). NITKU = NPWP16 + "000000" (HQ) — assumption, no NITKU column.
- WithholdingDate = run `payDate` (latest when several). Position = position name, XML escaped, max 50 chars (Catapa note, unconfirmed).
- `annual_statement` (A1, root `<A1Bulk>`) -> 422 `PAYROLL_TAX_EXPORT_NOT_SUPPORTED` this card (needs component-to-A1 field mapping; follow-up bead).
- Month 12 TER slips: still exported if method is ter (rare); annual recalculation slips excluded.

## Slices (no overlapping files)

- A `implementer` bank formats: `apps/api/src/lib/payroll-export/bank-formats.ts` (+ `csv.ts`).
  `type BankFileRow = { employeeId; employeeCode; employeeName; bankName: string|null; accountNumber; accountHolder; amountIdr: number }`;
  `type BankFileMeta = { payrollRunId; periodLabel /*YYYY-MM*/; payDate /*YYYY-MM-DD*/ }`;
  `interface BankFormatter { format; contentType; extension; render(rows, meta): string }`;
  `getBankFormatter(format): BankFormatter` -> `generic_csv` only; others throw `HttpError(422, ..., "PAYROLL_BANK_FORMAT_NOT_SUPPORTED")`.
  generic_csv header: `no,employee_code,employee_name,bank_name,account_number,account_holder,amount_idr,reference`; CRLF; UTF-8 no BOM;
  RFC 4180 quoting; formula-injection prefix `'` for cells starting `= + - @ \t \r`; account_number always quoted text; last line none.
- B `implementer` Coretax builder: `apps/api/src/lib/payroll-export/coretax-bpmp.ts`.
  `type BpmpRow = { taxMonth; taxYear; nik16; ptkpStatus; position; grossIdr; terRateBp; withholdingDate }`;
  `buildBpmpXml({ withholderTin16, nitku22, rows }): string` exactly the layout above (tabs, element order), validating digits.
  `formatTerRate(bp): string`.
- C `implementer` service + route + contract: `apps/api/src/services/payroll-export.service.ts`, `apps/api/src/routes/payroll-export.routes.ts`,
  register in `apps/api/src/routes/index.ts`; contract tweaks only in `packages/shared/src/hris/payroll/payslips.ts`/`endpoints.ts`
  (optional `summary` on tax export DTO: rowCount, excluded counts by reason). Uses A/B via the interfaces above.
  Bank file: lock check, build rows from bank_transfer slips net>0, `assertBankFileMatchesRun`, render, sha256, `uploadStorage`, insert row, `recordAudit` (no PII).
  Tax export: build BPMP, upload, insert `payroll_tax_exports` status `ready`, audit. Signed URL only on read.
- Tests: `test-writer` -> `apps/api/src/test/payroll-bank-export.test.ts` (route), `payroll-coretax-export.test.ts` (route),
  `payroll-export-formats.test.ts` (pure A/B unit tests).
