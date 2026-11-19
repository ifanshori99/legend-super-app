# Second opinion 1147: kas ronde 10

Hasil: **1 P1; tidak ada temuan P0/P2/P3 tambahan yang terbukti.** P2 ronde 9 tertutup secara statis, tetapi perubahan guard membuka kas tersedia palsu melalui reversal pembayaran bank setelah remapping. Skenario berikut berdasarkan penelusuran kode, belum direproduksi pada database.

## Basis pemeriksaan

- `git fetch origin` berhasil; `origin/ghostex/d158b041` tepat `f1f0c49870b0ac320ef93fb76b9340a5290a0cba`.
- Rentang: `bb1f85ab6cf510483734d79514336b929888cca3..f1f0c49870b0ac320ef93fb76b9340a5290a0cba`; nomor baris merujuk head tersebut. Pemeriksaan memakai `git diff`/`git show`, tanpa checkout atau worktree.
- Tiga subagent paralel: kasbon, bank/remapping, serta reimburse/supplier/payroll/aset. Agent utama memeriksa silang temuan dengan kode head dan guard pada base. Pengecualian yang diterima dalam brief 1142 beserta pendahulunya tidak dilaporkan ulang.

## Temuan

- **P1-1 — `apps/api/src/services/accounting-journal.service.ts:1130`: Mengabaikan mapping kas kecil sekarang ketika snapshot tersedia memungkinkan reversal pembayaran bank menciptakan kas tersedia palsu.** Skenario: petty cash A Rp0, bank B Rp100.000; bayar gaji `manual_bank` Rp100.000 sampai posting `settle` dengan jurnal Dr utang gaji/Cr B, sehingga B Rp0 dan snapshot tetap memuat `petty_cash=A, bank=B`. Dalam satu PUT mapping, pindahkan `bank` B→D dan `petty_cash` A→B, dengan D akun asset detail aktif yang belum dipakai role lain. Reverse jurnal pembayaran memakai idempotency key baru biasa: guard hanya menilai A, net kredit A=0, lalu return pada baris 1160 sebelum memeriksa posting `settle`. Reversal Dr B/Cr utang gaji menaikkan GL B dan kas tersedia menjadi Rp100.000 meskipun transfer gaji tetap dibayar; kasbon tunai berikut Rp100.000 dapat lolos tanpa dana nyata. **Perbaikan:** periksa net kredit snapshot dan mapping sekarang secara terpisah sehingga keduanya tidak saling meniadakan; bila reversal bank tetap diperbolehkan, wajib ada penahanan yang mencegah debit reversal menjadi kas tersedia. **Usul test:** bayar gaji bank→PUT dua role→reverse; wajib 409 `CASH_OUT_JOURNAL_LOCKED`, atau bila 200, available tetap Rp0 dan kasbon berikut ditolak 422 `PETTY_CASH_GL_INSUFFICIENT`. Pastikan posting tetap `settle`, pembayaran tetap tercatat, serta retry reversal tidak menambah saldo tersedia.

## Bukti silang P1-1

- Jurnal pembayaran bank benar memakai Dr `salaries_payable`/Cr `bank` (`packages/shared/src/accounting/posting-rules.ts:500–506`); jalur payout memilih `payout_bank` dan override rekening sumber (`apps/api/src/services/payroll-payout-gl.service.ts:775–790`). Snapshot menyimpan seluruh mapping efektif, termasuk petty A (`accounting-journal.service.ts:633–669,753`).
- Remap sah: role `bank` dan `petty_cash` sama-sama menerima asset; pemeriksaan akun bersama menilai mapping akhir (`packages/shared/src/accounting/coa.ts:176–177,336–359`). B dan D berbeda; tidak ada role kas yang berbagi akun.
- Endpoint reversal mengaktifkan kedua guard (`accounting-journal.service.ts:1055–1056`). Guard sumber baru melewati pemeriksaan posting `settle` (`:1213–1225`); guard kredit kas berikutnya melewatkan net debit B dari reversal (`accounting-petty-cash.service.ts:923–926`).
- Tidak ada cadangan pengganti untuk payroll bank yang sudah `settle`: cadangan posting hanya `settle_pending`/`settle_skipped` dari batch cash (`accounting-petty-cash.service.ts:594–599`), item approved juga cash (`:625–630`), event `settledPerItem` dilewati (`:685–688`), dan cadangan delivered hanya kasbon/reimburse (`:773–826`). `availableCash1102` memakai GL dikurangi cadangan tersebut (`:846–853`); pencairan kasbon memakai helper itu melalui guard (`payroll-loans.service.ts:743–748`).
- Trigger payout membaca idempotency key jurnal yang baru ditambahkan, bukan sumber `reversal_of`; key reversal baru biasa tidak cocok dengan `payroll-payout:*` (`apps/api/drizzle/0691_payout_waive_trusted.sql:422–447`). Reversal tidak mengubah posting asal dari `settle`.
- Ini regresi pada urutan tersebut: base `bb1f85ab6` memasukkan A dan B ke guard (`accounting-journal.service.ts:1127–1136`), menghasilkan net kredit Rp100.000 dan menolak karena sumber masih `settle`. Head hanya memasukkan A. Pengecualian jurnal manual/berulang tidak mencakup jurnal otomatis pembayaran gaji ini.

## Penutupan ronde 9 dan sumber lain

- P2-1 ronde 9 tertutup secara statis: untuk kasbon Dr piutang C/Cr petty A, guard kini hanya menjumlahkan A dari snapshot (`accounting-journal.service.ts:1128–1131`). Remap petty A→C tidak lagi menetralkan kredit A; sumber `disbursed`/`settled` ditolak (`:1190,1243–1247`). Legacy snapshot NULL tetap diperiksa berdasarkan sumber (`:1151–1154`).
- Test baru memeriksa swap mapping, 409, tidak terbentuk reversal, status kasbon tetap dibayar, dan penolakan pencairan berikut; ada kontrol legacy serta reimburse (`apps/api/src/test/petty-cash-reversal-remap.test.ts:424,455,474`). Test tersebut belum mencakup rantai payroll bank P1-1.
- Pada jalur kas asli yang ditelusuri, reimburse cash, supplier yang mengkredit petty cash, dan payroll cash tetap memakai snapshot kas historis serta guard status sumber. Payroll cash recovery juga override snapshot petty cash ke akun sumber historis (`payroll-payout-gl.service.ts:473–476`). Tidak ditemukan bypass tambahan yang konkret pada jalur tersebut.
- Akuisisi aset mengkredit utang pemasok; pembayarannya melalui supplier. Disposal mendebit bank dan penyusutan memiliki guard terpisah (`packages/shared/src/accounting/posting-rules.ts:759–765`; `accounting-journal.service.ts:1073–1100`). Tidak ada temuan tambahan yang terbukti pada aset tetap.

## Batas verifikasi dan perubahan

- Tidak menjalankan test database, build, migrasi, atau layanan. Klaim penutupan terbatas pada pemeriksaan statis; hasil test cabang tidak diklaim sebagai pengujian sesi ini.
- Checkout utama berada di `ux/customer-order-benchmark`, berbeda dari head review. Tidak menjalankan test checkout tersebut sebagai bukti bagi head `f1f0c4987`.
- `pnpm exec prettier --check docs/qa/second-opinion-kas-ronde10-1147.md` dicoba, tetapi gagal karena modul `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi untuk review ini. `git diff --no-index --check /dev/null <laporan>` tidak menghasilkan diagnostik whitespace (exit 1 karena berkas baru).
- Hanya laporan ini ditulis. Tidak mengubah kode, berkas progress, status Beads, atau berkas lain; tidak commit, push, merge, checkout, atau menghapus berkas.
