# Sub-brief 644: payroll O2 + O3 (worktree `.worktrees/payroll-644`, cabang `fix/payroll-o2-o3`)

Hanya edit di worktree ini. Uang/gaji: "jangan sampai rugi". Satu proses tsc/vitest sekaligus, lewat `heavy`.

## O2 `legend-bypw2` (simulate menagih piutang PPh 21)

- `apps/api/src/services/payroll-run-simulate.service.ts`: `assertNoOpenPph21Receivable` (~l.333) menolak 422 `PAYROLL_RUN_SIMULATE_UNSUPPORTED` bila ada piutang terbuka. Ganti: bangun baris penagihan piutang di simulasi, sesuai founder B8 dan `planPph21ReceivableCollection` (`packages/shared/src/hris/payroll/pph21-receivable.ts`, `fixtures.ts`). Lihat juga `payroll-run-compose.ts` (jalur compose/lock yang sudah menagih?) agar simulate = hasil lock.
- Invarian uang: tagihan <= piutang terbuka, <= batas yang diizinkan aturan B8 (tidak membuat gaji bersih negatif / tidak menagih lebih dari piutang), tidak ada karyawan dibayar lebih atau kurang dari run yang nanti dikunci. Data payslip tak terbaca atau saldo tak konsisten: tetap menolak (fail closed).
- Test yang sudah ada menyebut refusal: `payroll-run-followup-guards.test.ts`, `payroll-pph21-receivable-plan.test.ts`, `accounting-payroll-journal.test.ts`.

## O3 `legend-m6zdl` (reseal mencakup payroll_run_results)

- `apps/api/src/worker/hris-pii-reseal.job.ts` belum mereseal tabel `payroll_run_results`. Cabang trigger reseal ada di `payroll-run-results.custom.sql` (migrasi 0328). Tambahkan tabel+kolom terenkripsi itu ke job reseal, ikuti pola tabel lain di job itu (idempoten, per tenant, tidak mencetak nilai, tidak memecah AAD/key id).
- Migrasi bila perlu: rentang 0506-0507 (repo ini baru sampai 0329; pakai nomor 0506 apa adanya, cek registry/referensi test).

## Bukti

Test gagal-dulu karena sebab benar, lalu hijau. Tanpa log nilai gaji/PII.

## Ronde 1 review architect (tingkat K): 3 temuan wajib diperbaiki (O2)

Putusan: O3 reseal benar. O2 belum boleh merge.

1. **Penagihan ganda (karyawan dibayar kurang).** Piutang hanya dihitung saat simulate (`payroll-run-simulate.service.ts` ~339-407). Lock (`payroll-run-lock.service.ts` ~435-513) tidak memeriksa ulang; hanya mendeteksi slip lain lewat `priorPayslipIds` (badan hukum + tahun pajak sama, bulan sama/lebih awal). Skenario: piutang X terbuka; run Des dan Jan sama-sama disimulasi dan menagih X; keduanya dikunci, total tertagih 2X; lalu `pph21ReceivableBalance` melempar untuk seluruh badan hukum itu. Juga: off-cycle Feb dikunci setelah Mar.
2. **Reversal** (`payroll-run-reversal.service.ts` ~208): cek dependensi hanya bulan yang sama. Run Jan yang menimbulkan X bisa dibatalkan walau Feb sudah menagih X.
3. **Lintas badan hukum** (simulate ~361-367): tidak ada filter `legalEntityId`; badan hukum B menagih piutang milik A.

Perbaikan:

- A. Pindahkan loader piutang ke `apps/api/src/services/payroll-run-pph21.service.ts` (atau berkas bersama yang tidak membuat siklus impor) dan tambah filter `payrollRuns.legalEntityId = run.legalEntityId`; dipakai simulate dan lock.
- B. Di lock, setelah month lock dan sebelum `FOR UPDATE` baris run: advisory lock `payroll-pph21-receivable:${tenantId}:${legalEntityId}`; hitung ulang piutang terbuka (run lain locked/paid, badan hukum sama); untuk tiap karyawan tolak 409 `resultStale()` bila baris `pph21_receivable` di slip run ini tidak sama dengan `planPph21ReceivableCollection(openNow, room)`, room = gross dikurangi potongan selain `pph21_receivable`.
- C. Reversal: tolak bila slip run ini menimbulkan `pph21ReceivableIdr > 0` sementara ada run live lain (locked/paid) dengan baris `pph21_receivable` untuk karyawan yang sama (kode error ikuti pola reversal yang ada).
- D. Test di `payroll-run-followup-guards.test.ts`: dua run disimulasi, lock kedua ditolak (409); urutan Mar lalu Feb ditolak; lintas badan hukum tidak menagih; reversal ditolak. Gagal dulu.
  Fixture valid: slip seed harus lolos `payslipTotalsIssues` (lihat `seedOpenReceivable`).

## Keputusan CTO: tidak boleh menagih mundur (ronde 3)

Run hanya menagih piutang PPh 21 yang TIMBUL dari run dengan `payroll_runs.pay_date <= pay_date run ini` (sama = boleh). Sisanya tetap terbuka untuk run berikutnya.

Jebakan (wajib dijaga): menyaring SEMUA slip dengan pay_date membuat penagihan ganda lolos (Jan menimbulkan X, Mar menagih X, lalu Feb ikut menagih X karena slip Mar hilang dari saldo). Rumus loader `loadOpenPph21Receivables` (payroll-run-pph21.service.ts), per karyawan, slip run lain locked/paid badan hukum sama:

- integritas: `pph21ReceivableBalance(semua slip)` tetap dihitung dan tetap fail-closed bila inconsistent.
- fullOpen = raisedAll - collectedAll.
- raisedEligible = jumlah `tax.pph21ReceivableIdr` hanya dari slip run dengan pay_date <= payDate run ini.
- collectedAll = jumlah baris `pph21_receivable` dari SEMUA slip run lain (tanggal berapa pun).
- open = min(fullOpen, max(0, raisedEligible - collectedAll)). Hanya kembalikan bila > 0. (Konservatif: bisa menagih kurang, tidak pernah lebih; sisanya tetap terbuka.)
  Loader menerima `payDate` run ini; simulate dan lock (re-check) meneruskannya (lock memakai pay_date run yang dikunci). Reversal tidak berubah.

Test (gagal-dulu): (1) Mar menimbulkan X dan dikunci; Feb off-cycle (pay_date Feb) disimulasi: tagihan 0, simulate sukses, X tetap terbuka (saldo run Mar). (2) Jan timbul X, Mar menagih X (locked); Feb disimulasi: tagihan 0 (tidak ganda). (3) Simulasi Feb yang dibuat sebelum Mar dikunci menagih X: setelah Mar dikunci, lock Feb 409 PAYROLL_RUN_RESULT_STALE. (4) Kontrol: Jan timbul X, Feb (pay_date lebih lambat) menagih X seperti biasa; pay_date sama juga menagih.
