# legend-lzvh0 brief: kekurangan koreksi minus dipotong dari pembagian berikutnya

Worktree: `.worktrees/lzvh0` (branch `ws/lzvh0-unabsorbed-carry`). Jangan checkout folder utama, jangan push, jangan commit (engineer lead yang commit).
Typecheck/test/build hanya lewat `heavy <perintah>`; jangan jalankan `tsc` lebih dari sekali per perubahan kode. `cd <worktree>` eksplisit dan cetak `pwd` di tiap `bash -c`. Jangan ekspansi array zsh `${(@f)...}`, jangan `pkill`. Stempel waktu pakai `date`.

## Aturan founder (Q83)

Koreksi minus tidak membuat total pemegang saham di bawah nol. Kekurangan (`unabsorbed`) dipotong dari pembagian BERIKUTNYA pemegang saham yang sama, tidak pernah dibebankan ke pemegang saham lain. 8s992 hanya mencatat total di `distribution_runs.unabsorbed_idr`.

## Keputusan desain (final, jangan diubah tanpa lapor)

1. **Simpan per pemegang saham** di tabel baru `distribution_run_shortfalls` (satu baris per pemegang saham per run koreksi): `tenant_id, id, distribution_run_id (run adjustment), profit_entity_id, shareholder_id, amount_idr > 0, created_at`. Unique `(tenant_id, distribution_run_id, shareholder_id)`. Jumlah semua baris = `distribution_runs.unabsorbed_idr` run itu. Ditulis saat run koreksi dibuat (sama transaksi dengan `insertRun`).
2. **Efektif** bila run koreksi berstatus `approved` atau `paid` (tidak bisa dibatalkan setelah approve). Draft/pending tidak dihitung.
3. **Pemotongan** di tabel baru `distribution_carry_deductions`: `tenant_id, id, distribution_run_id (run regular), shortfall_id (FK ke shortfall asal), profit_entity_id, shareholder_id, amount_idr > 0, created_at`. Unique `(tenant_id, distribution_run_id, shortfall_id)`. Ini yang menjaga jejak ke koreksi asal.
4. **Sisa shortfall** = `amount_idr - sum(deduction)` dari run regular yang tidak `cancelled`. Run regular yang di-reject melepas potongannya otomatis (tidak ada baris yang dihapus: hitungan memfilter status).
5. **Urutan potong**: FIFO per pemegang saham (shortfall tertua dulu: `created_at`, lalu `id`).
6. **Hitung**: bagian kotor reguler tiap pemegang saham `S` (hasil largest remainder yang sudah ada). `potong = min(S, sisaTotalPemegangSaham)`. `gross = S - potong`. Pajak dihitung dari `gross` setelah potong (`applyBasisPoints` seperti biasa), `net = gross - pajak`. `gross == 0`: tidak ada baris untuk pemegang saham itu (schema melarang baris nol), tetapi potongannya tetap tercatat; sisa yang belum habis terbawa lagi.
7. **Total run regular**: `distributableIdr` tetap `periodNet - reserve` (check yang sudah ada). Kolom baru `distribution_runs.carry_deducted_idr` (default 0, >= 0, hanya `type='regular'`). Check totals jadi `distributable = total_gross + carry_deducted` dan `total_gross - total_tax = total_net`. Baris `distribution_lines` dapat kolom `carry_deducted_idr` (default 0, >= 0): potongan pemegang saham itu pada run tsb.
8. **Semua pemegang saham habis terserap** (tidak ada baris): lempar `AccountingError("NOTHING_TO_DISTRIBUTE")` dengan pesan yang menyebut kekurangan koreksi. Run tanpa baris tidak didukung state machine (`lines.min(1)`). Keterbatasan ini dilaporkan ke CTO.
9. **Jurnal**: tidak ada event jurnal baru. Jurnal penyelesaian `distribution.completed` memakai `totalGrossIdr` yang sudah dikurangi; deskripsi jurnal regular ditambah "(dipotong kekurangan koreksi Rp…)" bila `carry_deducted_idr > 0`. Event `distribution.approved/completed` payload dan audit `profit_share.distribution_calculated` memuat `carryDeductedIdr`. Tidak ada jurnal terpisah karena kekurangan tidak pernah dibukukan sebagai piutang.
10. **Approval** tetap `profit_share.distribution.approve`. Tidak ada permission baru.
11. **Statement/laporan**: DTO run memuat `carryDeductedIdr` dan `carryDeductions: [{shareholderId, shortfallRunId, amountIdr}]`; baris memuat `carryDeductedIdr`. Statement pemegang saham menampilkan baris "Potongan kekurangan koreksi" bila > 0.
12. **Migrasi** nomor sementara `0224`, `when` `1794303000000`, tag `0224_profit_share_carry`. Harus jalan sebagai migrator non-superuser (lihat `apps/api/drizzle/0219_profit_share.sql` dan `apps/api/src/test/migrator-role.test.ts`). `db:generate` harus kosong setelahnya. Tabel baru: RLS tenant seperti tabel profit-share lain (ikuti pola 0219: ENABLE + FORCE RLS, policy, grant). FK ke tabel ber-FORCE RLS: pola NO FORCE / FORCE (contracts.md pola 2).

## Antarmuka bersama (kontrak antar potongan)

Paket shared (`packages/shared/src/accounting/profit-share.ts`):

```ts
export type CarryShortfall = { shortfallId: string; amountIdr: number }; // sisa > 0, urut FIFO
export type CarryDeduction = { shareholderId: string; shortfallId: string; amountIdr: Idr };
calculateDistribution(input & { carry?: ReadonlyMap<string /*shareholderId*/, readonly CarryShortfall[]> })
  -> DistributionCalculation & { carryDeductedIdr: Idr; carryDeductions: CarryDeduction[] }
// distributionCalculationLineSchema & distributionLineSchema: tambah carryDeductedIdr (default 0)
// distributionRunSchema: tambah carryDeductedIdr, carryDeductions (default [])
// calculateAdjustmentDistribution: tambah unabsorbedByShareholder: Map<string, Idr> pada hasil (jumlah = unabsorbedIdr)
```

Drizzle (`apps/api/src/db/schema/accounting-profit-share.ts`): `distributionRunShortfalls`, `distributionCarryDeductions`, kolom `distributionRuns.carryDeductedIdr`, `distributionLines.carryDeductedIdr`.

## Potongan kerja

- A (shared): test gagal-dulu lalu hitungan + schema zod + fixture. File: `packages/shared/src/accounting/profit-share.ts`, `fixtures.ts`, test shared.
- B (db): schema drizzle, migrasi `0224`, journal, snapshot, test migrator non-superuser. File: `apps/api/src/db/schema/accounting-profit-share.ts`, `apps/api/drizzle/*`.
- C (service, setelah A dan B): `apps/api/src/services/profit-share-distribution.service.ts`, statement service, API test.
- D (web, setelah A): mock + tampilan potongan di `apps/web/src/features/ws07-profit-share/`.

## Perbaikan setelah review architect (potongan E)

1. HIGH `profit-share-distribution.service.ts` ~993-996: koreksi (claw-back maupun top-up) atas run regular yang punya pemegang saham terserap penuh gagal `SHARE_ALLOCATION_NOT_EXACT_100` karena porsi diambil dari `target.lines`. Ambil porsi dari `share_allocations` pada `target.shareVersion`. Claw-back: pemegang terserap memegang 0, tanpa baris. Top-up atas run dengan pemegang terserap: biarkan ditolak `assertAdjustmentMatchesTarget` dengan pesan jelas (jangan bayar pemegang yang punya utang terbuka; keputusan CTO nanti). Test gagal-dulu: skenario test (4) lalu koreksi klaw-bek run itu harus lolos.
2. MEDIUM `apps/api/drizzle/0224_profit_share_carry.sql`: tambah guard DB. (a) trigger insert pada `distribution_carry_deductions`: run harus `type='regular'` berstatus `draft` (belum beku), entity sama dengan shortfall, shortfall dari run koreksi `approved`/`paid`; (b) constraint trigger tertunda: jumlah deduction per run = `carry_deducted_idr` run, dan jumlah deduction aktif (run non-cancelled) per shortfall <= amount shortfall; (c) shortfall hanya boleh di-insert untuk run `type='adjustment'` berstatus `draft` dengan jumlah baris = `unabsorbed_idr` (tertunda). Pola trigger: lihat `accounting-profit-share.custom.sql`/0219. Test migrasi non-superuser gagal-dulu untuk tiap guard. `db:generate` tetap kosong.
3. LOW pemegang terserap penuh tak punya baris/statement: JANGAN diubah, dicatat sebagai keterbatasan.
4. LOW `profit-share-statement-pdf.ts` ~191-195: tampilkan "Bagian sebelum potongan" lebih dulu, lalu "Potongan kekurangan koreksi", lalu bagian kotor, supaya hitungan terbaca benar. Sesuaikan test statement.

## Putaran 2: keputusan CTO (menggantikan butir 8 dan keterbatasan sebelumnya)

Jangan ubah `lines.min(1)`. Tanpa jurnal terpisah (butir 9 tetap). Mock seed tidak ditambah.

1. **Baris nol.** Pemegang saham yang bagiannya habis terserap kini PUNYA baris: `gross 0, tax 0, net 0, carryDeductedIdr = bagiannya`. Itu sebabnya carry berkurang. Tidak ada lagi `NOTHING_TO_DISTRIBUTE` karena semua terserap. Baris nol hanya sah bila `carryDeductedIdr > 0` (zod, `distribution_lines` check, dan refine run/kalkulasi: gross >= 0, gross 0 hanya dengan carry > 0; kalkulasi `lines.some(gross <= 0)` dilonggarkan sama).
2. **Pembayaran baris nol.** Saat run di-approve, baris nol otomatis `paid` (paymentRef `POTONG-KEKURANGAN`, paidAt = approvedAt, paidBy = approver; tanpa statement/pdf/email). Bila setelah itu semua baris paid (semua nol), run langsung `paid` pada approve itu: `paid_at = approvedAt`, TANPA jurnal (`journal_entry_id` null; total gross 0 tak ada yang dijurnalkan). Guard DB "run paid wajib tepat satu jurnal" dan transisi approved→paid tanpa jurnal dilonggarkan hanya bila `total_gross_idr = 0`. State machine `transitionDistributionRun` (approve) di shared yang melakukan ini; service menyimpan baris dan status. Campuran (ada baris nyata): baris nyata dibayar biasa, run selesai saat baris nyata terakhir dibayar, jurnal biasa (gross sudah dikurangi); `completedAt` = max paidAt semua baris.
3. **Claw-back pada pemegang terserap**: perilaku sekarang tetap (butir 2 CTO). Pemegang terserap kini punya baris nol di run asal; porsi claw-back-nya tetap menjadi shortfall.
4. **Top-up (adjustment positif) atas run dengan pemegang terserap: diizinkan.** Kini lolos karena baris nol ada di run asal (porsi 10000 bp lengkap, `assertAdjustmentMatchesTarget` cocok). Tambahan untuk pemegang itu LEBIH DULU mengurangi carry-nya (FIFO, sama seperti run reguler, dalam run top-up itu sendiri), sisanya dibayar; habis terserap = baris nol. Jadi potongan carry berlaku untuk run `regular` dan `adjustment` positif: `carry_deducted_idr` boleh > 0 pada adjustment dengan `distributable > 0`, dan `distributable = total_gross + carry_deducted`. Adjustment negatif: carry 0. Hapus penolakan `ADJUSTMENT_TARGET_INVALID` "kekurangan koreksi" untuk top-up. Pada service top-up: ambil sisa carry per pemegang saham (fungsi yang sama dengan run reguler), kirim ke kalkulasi.
5. Semua tes lama yang berasumsi "semua terserap = NOTHING_TO_DISTRIBUTE" atau "top-up ditolak" diubah mengikuti keputusan ini.

Potongan: F1 shared (kalkulasi, zod, state machine approve), F2 DB (relax migrasi 0224 di tempat karena nomor sementara belum dirilis: check lines, check run carry untuk adjustment positif, guard paid tanpa jurnal bila gross 0, trigger deduction izinkan adjustment positif draft, snapshot 0224 diperbarui, `db:generate` kosong), F3 service + web (setelah F1 dan F2).

## Putaran 2: temuan architect (potongan G, semua failing-first di `apps/api/src/test/profit-share-distribution.test.ts`)

- F1 (opsi b, diterima): klaw-bek atas run yang SEMUA barisnya nol tetap ditolak. Beri kode/pesan jelas (bukan `ADJUSTMENT_EXCEEDS_PAID` yang menyesatkan): tolak dengan `ADJUSTMENT_TARGET_INVALID` dan pesan Indonesia "Run ini seluruhnya terserap kekurangan koreksi; tidak ada yang bisa ditarik kembali". Tambah test. Dilaporkan ke CTO sebagai keterbatasan.
- F2: baris nol (`grossIdr = 0 AND carryDeductedIdr > 0`) tidak boleh muncul sebagai statement: kecualikan dari `ownLines`/`getMyProfitShareService`, dan `getDistributionStatementService` untuk baris itu: 404. Test.
- F3: run yang menjadi `paid` saat approve (semua baris nol) menambahkan event `distribution.completed` dengan `journalEntryId: null` (cek `packages/shared/src/accounting/profit-share-events.ts` menerima null; ubah bila perlu + test event).
