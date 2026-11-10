# Sub-brief: kekurangan potong PPh 21 jadi piutang karyawan (legend-kn3n bagian 2, legend-6ajk, legend-xzid; tingkat K)

Brief induk: `legend/docs/briefs/170-pph21-employee-receivable.md` (folder utama). Cabang `ws/pph21-overwithhold`, HEAD 1535d4d8. Notasi: header `packages/shared/src/hris/payroll/pph21.ts` dan `docs/briefs/sub-pph21-takehome-cap.md`.

## Keputusan founder B8 (mengikat)

Kekurangan potongan karyawan = PIUTANG KARYAWAN, bukan beban perusahaan. Setoran tetap T. Tanpa gross-up. Berlaku untuk kelebihan di atas cap (bulan TER dan Desember) dan karyawan keluar / Desember tanpa gaji. Penagihan: dipotong dari gaji berikutnya sampai batas gaji tersedia; sisa saat keluar tetap piutang terbuka untuk finance. Default `mixedSchemeAllocation` JANGAN diubah (kn3n bagian 1 ke konsultan).

## Keadaan sekarang (1535d4d8)

- Engine: excess = max(0, employeePart + employeeBalance − settled − cap) pindah ke perusahaan di titik tetap (borne, masuk X = gross-up) atau mengurangi refund perusahaan. `pph21CapExcessIdr` (hasil, prior) = bagian borne yang excess; Desember `settled = min(priorCapExcess, charge)` di `netsAt`.
- legend-6ajk (Codex 156 run 3, `legend/docs/briefs/156-second-opinion-pph21-overwithhold.result3.md`): settlement Rp1 masuk X, PKP 55.652.000 → 55.653.000, W Desember 658.540 → 658.589. Skenario: TK/0 NPWP proportional; Jan gross 10 jt cap caller 199.998 (borne 2, excess 1); Feb net 5,4 jt; Mar–Nov gross 10 jt; Des gross 9.900.147.
- Belum ada builder payslip produksi: `calculatePayrollRunTax` hanya dipanggil test. Builder terdekat `calculate()` di `packages/shared/src/hris/payroll/fixtures.ts:1111-1290` (BPJS `:1172-1191`, deductible JHT+JP `:1202`, `computePayslipTax` `:1207`, netBeforeLoans = gross − BPJS karyawan − PPh − LATE `:1235`, pinjaman `planLoanDeductions` `:1240`, urutan BPJS_EMP, PPH21, LATE, LOAN `:1250-1259`).
- Pinjaman: hanya kontrak shared (`loans.ts`, `planLoanDeductions` `:232-272`: plafon = min(netBeforeLoans, maxDeductionOfNetPayBp × net), tertua dulu, sisa `carriedIdr`), kategori slip `loan_installment` (`components.ts:45,56`), event lock `loan_installments_deducted` (`run.ts:164-182`). Tidak ada tabel DB pinjaman/payslip/run; satu-satunya skema payroll: `payroll-pph21-policy.ts`.
- Jurnal: aturan `payroll_run.completed` di `packages/shared/src/accounting/posting-rules.ts:245-257` (Dr salary_expense gross, Dr bpjs_expense; Cr salaries_payable net, Cr bpjs_payable, Cr pph21_payable = pph21Idr). Belum ada kode produksi yang memposting. CoA `packages/shared/src/accounting/coa.ts`: tidak ada akun piutang karyawan (1201 Piutang Usaha, 1202 Kliring PG). `accounting_open_items` hanya supplier/corporate_account/event_customer.
- Migrasi terakhir: idx 133 `0133_kind_hitman`.

## Usulan engineer (validasi/ubah)

1. Engine: excess tidak lagi masuk sisi perusahaan. covered = least fixed point S = max(0, Dr + bR) seperti 6e20273a (tanpa excess, tanpa settled). Karyawan: charge = employeePart + employeeBalance; W = clamp(charge, 0, cap); `pph21ReceivableIdr` = max(0, charge − cap) (tanpa gross-up, tidak masuk X); employeeRefund = max(0, −charge). Identitas: withheld + borne + receivable − refundKaryawan − refundPerusahaan = T.
2. Ganti `pph21CapExcessIdr` (belum pernah rilis, hanya di cabang ini) dengan `pph21ReceivableIdr` di hasil, prior (`prior.pph21ReceivableIdr`, default 0) dan `payslipTaxSchema` (opsional). Rekalkulasi tahunan: priorTax = withheld + borne + receivable; receivable dihitung pajak karyawan (pEeT). Jalur settlement hilang, jadi 6ajk hilang (W tidak bisa naik akibat settlement).
3. Penagihan: fungsi shared baru `planPph21ReceivableCollection` (pola `planLoanDeductions`): saldo terbuka dari slip sebelumnya, dipotong sampai cap tersisa setelah W (dan setelah BPJS/LATE), kategori slip baru `pph21_receivable`. Urutan vs pinjaman: usul SEBELUM pinjaman (utang pajak yang sudah disetor perusahaan; pinjaman sudah punya `carriedIdr`). Refund karyawan (H < 0) menutup piutang terbuka dulu.
4. Builder (xzid): helper shared `payslipWithholdingCap({ cashEarnings, taxAllowance, bpjsEmployee, preNetDeductions })` = tunai tanpa tunjangan PPh − semua BPJS karyawan − potongan pra-net non-pinjaman (LATE); `calculate()` di fixtures mengisi `employeeWithholdingCapIdr`.
5. Jurnal: akun CoA baru "Piutang Karyawan" (mis. 1203, key `employee_receivable`); aturan `payroll_run.completed`: Dr employee_receivable = piutang baru, Cr employee_receivable = penagihan (mengurangi utang gaji). Tanpa migrasi DB (tidak ada tabel payroll); bila CoA perlu seed per tenant di DB, nilai apakah perlu migrasi. Piutang terbuka saat keluar: cukup saldo akun + field slip, atau perlu open item karyawan (migrasi CHECK)?

## Pertanyaan untuk architect

- Q1 Rumus engine final (poin 1–2), termasuk bulan TER, employer refund (T < 0) bersamaan dengan piutang, partialYear, dan bagaimana receivable prior masuk rekalkulasi (pEeT; `gross_first` annual(Gs) − pEeT).
- Q2 Refund karyawan vs piutang terbuka: di engine atau di planner slip?
- Q3 Urutan potongan dan plafon penagihan (sebelum/sesudah pinjaman; plafon = cap tersisa atau ada batas persen seperti pinjaman).
- Q4 Penyimpanan + jurnal + CoA (poin 5): perlu migrasi atau tidak; nomor dan `when` bila perlu.
- Q5 Test yang berubah (R63, M1, O6, K1–K4, C2, S2, takehome-cap fuzz) dan angka tepat R63 sebelum/sesudah, skenario 6ajk sesudah.

Validasi di salinan engine di scratchpad (bukan worktree), jalankan fuzz invarian: setoran = T, W ≤ cap, take-home ≥ 0, receivable = charge − W ≥ 0, tidak ada gross-up atas receivable (X tanpa receivable), refund ≤ yang dibayar pembayar.

## Tugas test-writer putaran 1 (reproduksi, harus gagal di 1535d4d8)

File baru `apps/api/src/test/payroll-pph21-receivable.test.ts`, invarian saja (angka tepat menyusul setelah architect):

- R63-seperti (lihat R63 di `payroll-pph21-annual.test.ts`): Desember tanpa gaji, kekurangan → `pph21EmployerBorneIdr` 0, `taxAllowanceIdr` 0, `pph21ReceivableIdr` = T, `taxableGrossIdr` = garis + benefit (tanpa covered), W 0.
- Bulan TER hanya benefit (M1 di `payroll-pph21-history-split-reference.test.ts`): borne 0, receivable = T, X = benefit.
- 6ajk (skenario di bagian "Keadaan sekarang"): W Desember ≤ 658.540 dan tidak ada borne yang berasal dari excess.
- Fuzz setahun (pakai pola `payroll-pph21-takehome-cap.test.ts`, akumulasi `pph21ReceivableIdr` ke prior): withheld + borne + receivable − refunds = T; W ≤ cap; receivable ≥ 0; receivable > 0 → W = cap.

## Keputusan architect (final)

- Q1 engine: `prior.pph21ReceivableIdr` (ganti `pph21CapExcessIdr`); priorTax = withheld + borne + receivable; pEeT memuat receivable. covered = titik tetap 6e20273a (`Dr + bR`). charge = De + bE; W = clamp(charge, 0, cap); `pph21ReceivableIdr` = max(0, charge − cap); refund karyawan = max(0, −charge). A/B/refund perusahaan persis 6e20273a. Identitas: W + A + B + receivable − kedua refund = T. Oracle: sama dengan 6e20273a bila receivable dianggap withheld.
- Q2: netting refund vs piutang terbuka di planner slip (refund = earning `PPH21_REFUND`, jadi ruang penagihan ≥ refund).
- Q3: urutan BPJS_EMP, PPH21, LATE, PPH21_RECEIVABLE, LOAN. Plafon penagihan = netBeforeLoans (100%, tanpa batas persen). Pinjaman memakai sisa. Piutang baru di slip yang sama tidak ditagih di slip itu.
- Q4: tanpa migrasi. Role CoA `employee_receivable` (asset), akun 1204 Piutang Karyawan (1203 dipakai Kliring EDC). Open item party `employee` ditunda (butuh CHECK) ke bead tabel payroll.
- Q5 angka: R63 sebelum X = T = B = 5.646.900; sesudah X 0, T 4.800.000, W 0, B 0, piutang 4.800.000. 6ajk Desember sesudah: X 10.024.209, T 782.600, W 658.538, B 124.062, PKP 55.652.000. Lainnya: lihat laporan architect di bawah "Tugas test-writer putaran 2".
- Model: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/d40e2095-9e42-418b-b8b4-2171af7d1f96/scratchpad/arch3/` (`pph21.rcv.mts`, `fuzz.mts`, `hand.mts`, `o6.mts`).

## Tugas implementer A (modul piutang + builder, xzid)

File: `packages/shared/src/hris/payroll/pph21-receivable.ts` (baru, export di `packages/shared/src/hris/payroll/index.ts`), `components.ts`, `fixtures.ts` `calculate()`, label web `apps/web/src/features/ws10-payroll-config/labels.ts` + pesan i18n terkait. JANGAN sentuh `pph21.ts`, `payslips.ts`, `payslip-tax.ts` (engineer) dan `packages/shared/src/accounting/*` (implementer B).

1. `pph21-receivable.ts`: `pph21ReceivableBalance(slips)` = Σ `tax.pph21ReceivableIdr` (absen = 0) − Σ baris kategori `pph21_receivable`, lintas tahun; `planPph21ReceivableCollection({ openIdr, roomIdr })` → `{ collectedIdr = min(open, max(0, room)), openAfterIdr }`. Whole rupiah, tolak negatif/pecahan. JSDoc: founder B8.
2. `components.ts`: kategori deduction baru `pph21_receivable` (masuk set potongan seperti `loan_installment`); komponen `PPH21_RECEIVABLE` bila ada katalog komponen.
3. `fixtures.ts` `calculate()`: isi `employeeWithholdingCapIdr` lewat `payslipWithholdingCap` dari `payslip-tax.ts` (engineer menambahkannya: `payslipWithholdingCap({ cashEarningsIdr, bpjsEmployeeIdr, preNetDeductionsIdr })` = max(0, cash − bpjs − preNet); cash = earning sebelum TAX_ALLOWANCE/PPH21_REFUND); input opsional `pph21ReceivableOpenIdr` (default 0); baris `PPH21_RECEIVABLE` setelah LATE, sebelum LOAN; pinjaman memakai netBeforeLoans − collected. Fixture lama harus tetap sama angkanya (piutang 0).
4. Test unit di `apps/api/src/test/payroll-pph21-receivable-plan.test.ts`: balance, planner, urutan potongan di `calculate()` (penagihan sebelum pinjaman, pinjaman carried), cap terisi.

## Tugas implementer B (jurnal + CoA)

File: `packages/shared/src/accounting/coa.ts`, `posting-rules.ts`, `accounting/fixtures.ts` (+ test akuntansi terkait). Jangan sentuh file payroll.

1. `coa.ts`: role `employee_receivable: "asset"`; akun `["1204","Piutang Karyawan","current_asset","1200",["employee_receivable"]]` (ikuti format baris yang ada; cek 1204 belum dipakai).
2. `posting-rules.ts` aturan `payroll_run.completed`: tambah `["employee_receivable","debit","pph21ReceivableIdr"]` dan `["employee_receivable","credit","pph21ReceivableCollectedIdr"]`; komentar founder B8.
3. `accounting/fixtures.ts` (~:290): tambah kedua key bernilai 0.
4. Test: posting payroll dengan piutang > 0 dan penagihan > 0 seimbang; cakupan role CoA (cari test yang memeriksa semua role terpetakan). Catat bila aturan payroll sudah tidak seimbang untuk LATE/LOAN/borne/refund (jangan perbaiki; laporkan).

## Tugas test-writer putaran 2 (selaraskan test lama ke engine piutang)

Engine sudah diganti (lihat "Keputusan architect"). Test lama masih memakai `pph21CapExcessIdr` dan angka gross-up. Ubah HANYA file test ini:
`apps/api/src/test/payroll-pph21-prior-reference.test.ts`, `payroll-pph21-prior.test.ts`, `payroll-run-pph21-db.test.ts`, `payroll-pph21-takehome-cap.test.ts`, dan `payroll-pph21-receivable.test.ts` (hapus cast lokal, pakai field bertipe; tambah regresi 6ajk dengan angka persis).

- Ganti `pph21CapExcessIdr` jadi `pph21ReceivableIdr` (prior dan hasil). Prior: priorTax = withheld + borne + receivable. Identitas slip: withheld + borne + receivable − refunds = pph21Idr.
- Angka architect (dari model `arch3/pph21.rcv.mts`; cek dengan `apps/api/node_modules/.bin/tsx <file>` bila ragu, jangan ubah engine):
  - R63: X 0, T 4.800.000, W 0, B 0, piutang 4.800.000, PKP 72.000.000 (sebelum: X = T = B = 5.646.900, PKP 77.646.000).
  - 6ajk Desember: X 10.024.209, T 782.600, W 658.538, B 124.062, PKP 55.652.000. Januari: W 199.998, piutang 2, X 10.000.000.
  - M1/K1 Januari: X 8.000.000, T 120.000, piutang 120.000. K1 Desember: X 10.000.000, T 785.000, W 785.000, B 0.
  - O6 proportional: W 2.000.000, piutang 3.781.819, refund perusahaan 7.481.819. S2 proportional: W 1.000.000, piutang 1.486.089, refund perusahaan 11.193.115.
  - C2: X 200.000, T 334.500, W 200.000, B 0, piutang 134.500.
  - K2/K3 Desember: T −120.000, refund karyawan 120.000, refund perusahaan 0. K4: W Desember = W versi 6e20273a (`git show 6e20273a:packages/shared/src/hris/payroll/pph21.ts`).
  - Cap pemanggil (`employeeWithholdingCapIdr`): kelebihan jadi piutang, X tidak naik.
- Fuzz takehome-cap: akumulasikan `pph21ReceivableIdr` ke prior; invariant W ≤ cap, W ≥ 0, identitas di atas, setoran = T.
- Angka yang beda dari daftar di atas: JANGAN sesuaikan diam-diam; laporkan kasus, angka engine, angka model.
- Bukti: `LEGEND_TEST_FILES="src/test/<5 file>" pnpm test` dari root worktree, semua hijau; prettier + eslint di file yang diubah. Jangan commit.
