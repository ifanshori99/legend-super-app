# Sub-brief: PPh 21 prior-year builder (bd legend-s5c1, tingkat K)

## Masalah

`computePph21Period` (packages/shared/src/hris/payroll/pph21.ts) menerima `prior`
(Jan–Nov, atau periode sebelumnya di tahun pajak yang sama). Field opsional
`taxAllowanceIdr`, `grossSchemeBaseIdr`, `employerSchemeBaseIdr` sering terlupa.
Tanpa itu: karyawan gross-up ditagih kekurangan (shortfall) yang didanai perusahaan,
dan menerima refund (lebih potong) atas pajak yang didanai perusahaan.

## Kontrak baru (packages/shared/src/hris/payroll/payslip-tax.ts)

```ts
export type Pph21PriorPeriod = {
  /** Earnings the period's tax was computed from — same as computePayslipTax input
   *  (without TAX_ALLOWANCE / PPH21_REFUND lines). */
  earnings: readonly PayslipTaxEarning[];
  employerBenefitIdr: Idr | number;
  employeeDeductibleIdr: Idr | number;
  /** Stored tax of that payslip. */
  tax: PayslipTax;
};
export type Pph21Prior = {
  taxableGrossIdr;
  employeeDeductibleIdr;
  pph21WithheldIdr;
  pph21EmployerBorneIdr;
  grossSchemeBaseIdr;
  employerSchemeBaseIdr;
  taxAllowanceIdr;
}; // all Idr, all required
export function buildPph21Prior(
  periods: readonly Pph21PriorPeriod[],
): Pph21Prior;
```

Aturan:

- taxableGrossIdr = Σ tax.taxableGrossIdr; employeeDeductibleIdr = Σ input; withheld/borne/allowance = Σ.
- Skema per periode: base g = taxable gross-scheme lines + employerBenefit, u = gross_up, n = net.
  grossSchemeBase (bagian karyawan) = g bila u+n = 0, selain itu grossLines + floor(benefit × grossLines / (grossLines+u+n)).
  employerSchemeBase = tax.taxableGrossIdr − grossSchemeBase (termasuk tunjangan pajak & pajak ditanggung).
- Menolak (RangeError): periode `method: "annual_recalculation"` atau refund > 0 di periode sebelumnya;
  tax.taxableGrossIdr < g+u+n; nilai negatif / bukan bilangan bulat.
- `[]` → semua 0.

## Run service (apps/api/src/services/payroll-run-pph21.service.ts)

`PayrollRunTaxEmployee` tidak lagi menerima `prior` mentah; menerima `priorPeriods: readonly Pph21PriorPeriod[]`
dan service memanggil `buildPph21Prior`.

## Invarian yang harus dibuktikan test

1. Karyawan murni gross-up, periode terakhir dengan lebih potong: employee refund = 0 (proportional dan gross_first).
2. Karyawan murni gross-up, periode terakhir dengan shortfall: withheld == taxAllowance (karyawan tidak menanggung apa pun).
3. Tahun tanpa pajak (TER 0%) skema net: employerSchemeBase = Σ X, grossSchemeBase = 0.
4. Campuran gross + net + benefit: split sesuai rumus floor di atas, Σ dua base = Σ X.
5. Penolakan input di atas.

## File

- Implementasi: pph21.ts (helper split skema dibagi engine & builder), payslip-tax.ts, run service + test db-nya.
- Test baru: apps/api/src/test/payroll-pph21-prior.test.ts (engineer) dan
  apps/api/src/test/payroll-pph21-prior-reference.test.ts (test-writer, nilai dihitung tangan).

## Test terarah

`LEGEND_TEST_FILES="src/test/payroll-pph21-prior.test.ts" pnpm test` dari root worktree.

## Revisi setelah review architect

- `PayslipTax` menyimpan `grossSchemeBaseIdr` + `employerSchemeBaseIdr` (dihitung `computePayslipTax`), karena baris payslip tidak menyimpan `taxScheme`.
- `Pph21PriorPeriod = { tax, employeeDeductibleIdr }`; builder hanya menjumlah nilai tersimpan dan menolak data tidak konsisten.
- Caller hanya mengirim payslip sesudah annual recalculation terakhir (rehire = masa kerja baru).
