# Hasil 170b — PPh 21 piutang karyawan

Tanggal: 9 November 2026. Prosedur: `217-review-queue-procedure.md`, run gabungan 219.

| Id brief | Kartu | Hasil | Kartu baru | Catatan |
| --- | --- | --- | --- | --- |
| 170b | legend-6ajk, legend-xzid | Temuan P2 | legend-5yeyq | Ambang PKP sudah benar; cap tunai non-pajak masih diabaikan engine. |

## Basis dan ruang lingkup

- Diff awal: `1535d4d8..7b486d73` (4fa8159d, 7b486d73), dilanjutkan pemeriksaan perubahan pada berkas terkait sampai `milestone/m1@94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`.
- Subagent Codex memeriksa brief ini; induk membaca ulang jalur cap dan menjalankan reproduksi sendiri dengan riwayat bulanan yang dihasilkan engine.
- Pemeriksaan read-only terhadap kode repo. Hanya berkas hasil ini ditulis; tidak ada checkout, staging, commit, push, atau penutupan kartu. Run 219 memakai 3 subagent, puncak 3 paralel.

## Temuan P2 / major — legend-5yeyq

`packages/shared/src/hris/payroll/pph21.ts:552` (blok 552–559): cap dari caller kembali dibatasi oleh penghasilan kena pajak, sehingga cash non-pajak tidak dapat dipakai untuk membayar PPh 21.

`computePayslipTax` membuang earning non-pajak dari `taxableLines` (`payslip-tax.ts:79`), lalu engine menghitung batas `grossLines + u + n - deductible`. Caller cap yang lebih besar tidak dapat menaikkan batas tersebut. Ini berbeda dari definisi cap brief/B8: seluruh tunai tanpa tunjangan PPh, dikurangi semua BPJS karyawan dan potongan pra-net non-pinjaman.

Skenario Rupiah terverifikasi, tanpa prior buatan:

- TK/0, NPWP, BPJS dan LATE nol; Januari–November gross Rp10.000.000 per bulan. Engine menghasilkan prior taxable Rp110.000.000 dan withheld Rp2.200.000.
- Desember hanya earning tunai non-pajak Rp1.000.000. `payslipWithholdingCap` menghasilkan cap Rp1.000.000.
- Aktual: T Rp325.000, potongan karyawan Rp0, piutang baru Rp325.000, take-home Rp1.000.000.
- Seharusnya: T tetap Rp325.000, potongan karyawan Rp325.000, piutang Rp0, take-home Rp675.000.

Saran: jadikan cap caller yang sudah menghitung seluruh cash sebagai cap otoritatif, atau teruskan cash non-pajak secara eksplisit ke engine. Tambahkan regresi Desember/karyawan keluar dengan cash non-pajak. Jangan mengubah taxable gross, gross-up, atau default alokasi riwayat campuran.

Pencarian duplikat `pph21`, `piutang`, `non-taxable`, `non pajak`, dan `non-tax` tidak menemukan kartu untuk kegagalan ini. `legend-xzid` membahas pengisian cap oleh builder; temuan baru terjadi setelah cap itu sudah diisi benar.

## Jawaban pertanyaan brief

1. Identitas setoran `withheld + borne + receivable - refunds = T` dan tidak adanya gross-up atas piutang tetap benar pada test/probe. Namun W dan piutang salah pada contoh di atas. Test cap/take-home serta oracle subagent 24.000 periode tidak menemukan kenaikan X akibat piutang.
2. Piutang prior dihitung sekali sebagai pajak karyawan yang telah dibayar, termasuk yang belum tertagih (`pph21.ts:393–397,430–431`; `payslip-tax.ts:194–245`). Probe keluar: Januari T Rp200.000, W Rp150.000, piutang Rp50.000; Februari tanpa gaji menghasilkan refund Rp200.000, collection Rp50.000, cash refund Rp150.000. Kasus Desember tanpa gaji juga tercakup test receivable.
3. Regresi ambang PKP `legend-6ajk` tidak ditemukan lagi. Titik tetap sekarang hanya memakai bagian perusahaan (`pph21.ts:565–583`). Probe ambang menghasilkan PKP Rp55.652.000, W Desember Rp658.538, T Rp782.600; piutang tidak menaikkan X atau W melalui settlement lama.
4. Urutan pada builder fixture: BPJS, PPh 21, LATE, collection piutang, pinjaman (`fixtures.ts:1254–1286`). Collection memakai saldo awal, sehingga piutang baru tidak ditagih pada slip yang sama. Refund menambah ruang collection; planner membatasi collection ke saldo awal dan kas tersedia (`pph21-receivable.ts:67–77`).
5. Pada m1 jurnal sudah memakai `payroll.locked/reversed`, menggantikan aturan lama `payroll_run.completed`. Piutang baru Dr, collection Cr (`posting-rules.ts:142,146`); totals memakai key yang sama (`payslips.ts:462–464`, `accounting/payroll-journal.ts:65–66`). Test jurnal receivable lulus.
6. Field baru boleh absen; JSON yang masih memuat `pph21CapExcessIdr` ditolak strict schema (`payslips.ts:82–117`). Subbrief menyatakan field lama belum dirilis. Tidak ditemukan referensi produksi/tabel payslip lama yang membuktikan kerusakan data; kompatibilitas dengan field lama bukan jaminan yang diberikan skema saat ini.

## Bukti verifikasi

- Snapshot sementara bersih dari `git archive` SHA di atas, dependensi dari lockfile dengan `pnpm install --frozen-lockfile --ignore-scripts`.
- Run induk melalui `heavy`, `LEGEND_TEST_FILES` berisi 12 berkas: receivable, takehome-cap, receivable-plan, prior, prior-reference, accounting-payroll-receivable, provisioning-race, provisioning-defaults, tax-provisioning, tax-rule-overlap, tax-service-overlap, tax-service-default. Hasil: **12 berkas / 168 test lulus**, exit 0. Log: `/tmp/legend-219-snapshot-tests.log`.
- Reproduksi independen induk: `/tmp/legend-review-219-94d769c6/review-219-pph21.mts`, dijalankan dengan `apps/api/node_modules/.bin/tsx`, exit 0; mengonfirmasi angka contoh di atas.
- Probe subagent meliputi ambang PKP, Desember tanpa gaji, refund/netting keluar, jurnal, kompatibilitas skema, dan oracle 2.000 tahun / 24.000 periode; laporan subagent dipakai sebagai tambahan, bukan pengganti run induk.
- Percobaan awal pada worktree m1: 7 berkas / 93 test lulus, 3 suite pajak gagal import `@pdf-lib/fontkit`. Kegagalan dependensi tersebut tidak terjadi pada snapshot dengan dependensi lengkap.
- Lint, typecheck, build, e2e, dan data produksi tidak diuji; tidak ada kode repo yang diubah. Tidak ada P0/P1 yang ditemukan dalam scope.
