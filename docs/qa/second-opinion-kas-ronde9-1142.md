# Second opinion 1142: kas ronde 9

Hasil: **1 P2; tidak ada temuan P0/P1/P3 tambahan yang terbukti.** Rantai pembukaan kas semu ronde 8 tertutup secara statis oleh cadangan baru, tetapi kewajiban menolak reversal sumber yang masih dibayar dengan 409 belum utuh. Temuan berikut berasal dari penelusuran kode, belum direproduksi pada database.

## Basis pemeriksaan

- `git fetch origin` berhasil. Head terpin: `bb1f85ab6cf510483734d79514336b929888cca3`, `origin/ghostex/d158b041`.
- Fokus: `eab61aa7a30446ccd82b384148500609d21da992..bb1f85ab6`; konteks: `origin/milestone/m1...bb1f85ab6`, dengan milestone teramati `494228f7b7fd3d52b27c81e1cc4f83dfc5e8c968` dan merge-base `2f319094e8353c118f08969801ffa960f7a10de7`.
- Snapshot `**/meta/*snapshot.json` dikecualikan. Nomor baris merujuk head review, bukan checkout utama.
- Pengecualian brief 1066/1074/1089/1105/1115/1138 serta urutan kunci impor pajak/service-charge tidak dilaporkan ulang.
- Subagent: total 3, puncak 3 bersamaan; reversal/sumber, impor/mapping, dan SQL/cadangan. Agent utama memeriksa silang skenario temuan dan menggabungkan hasil. Tidak mengambil token `heavy`.

## Temuan

- **P2-1 — `apps/api/src/services/accounting-journal.service.ts:1154`: Penjumlahan mapping sekarang dan snapshot dapat meniadakan kredit historis, sehingga reversal kasbon yang masih `disbursed` lolos.** Skenario: akun petty cash A berisi Rp100.000; cairkan dan consume kasbon Rp100.000 dengan jurnal Dr piutang karyawan C/Cr A, sehingga GL A=0 dan C=Rp100.000. Dalam satu PUT mapping, pindahkan `employee_receivable` C→D dan `petty_cash` A→C; A/C/D adalah akun detail asset aktif pada entity yang sama, tanpa role berbagi. Reverse jurnal asli melalui endpoint manual. Guard menjumlahkan kredit A dan debit C menjadi `+100.000−100.000=0`, lalu return pada baris 1157 sebelum memeriksa status sumber. Guard kredit reversal juga lolos karena mapping saat ini C mempunyai saldo Rp100.000 dan cadangan sebelum reversal nol. Reversal tercatat meski kasbon masih dibayar, bertentangan dengan keputusan wajib 409 pada brief 1140. **Tidak terbukti pembayaran berlebih pada rantai ini:** setelah reversal, helper baru menahan Rp100.000; remap kembali ke A menghasilkan kas tersedia nol. Perbaikan: evaluasi neto akun snapshot historis terpisah dari mapping sekarang, atau periksa status sumber kas keluar yang dikenal tanpa membiarkan neto gabungan membatalkannya. **Usul test:** rantai HTTP cairkan→consume→PUT dua role tadi→reverse; wajib 409 `CASH_OUT_JOURNAL_LOCKED`, tidak membuat reversal, dan sumber tetap `disbursed`. Pertahankan kontrol legacy tanpa snapshot serta penolakan pencairan kedua.

## Bukti silang temuan

- Remap tersebut sah: `packages/shared/src/accounting/coa.ts:176,182` menerima asset untuk kedua role; validasi pada `:336–359` memeriksa tipe/header dan role berbagi dalam mapping akhir, tanpa larangan memakai akun debit historis. `accounting-accounts.service.ts:291–348` memvalidasi lalu mengganti seluruh mapping secara atomik.
- Endpoint manual memasang `manualReversal: true` dan `guardPettyCash: true` pada `accounting-journal.service.ts:1055–1056`. Pemeriksaan sumber dipanggil pada `:1409–1415`, tetapi return pada `:1157` melewati pembacaan kasbon dan penolakan pada `:1187,1240–1244`.
- Sesudah guard sumber, `:1434–1440` memeriksa kredit reversal terhadap mapping saat ini melalui `accounting-petty-cash.service.ts:912–933`. Kredit C sebesar Rp100.000 tertutup saldo debit C dari jurnal asli. Neto jurnal asli pada snapshot A masih Rp100.000, sehingga helper delivered belum menahan cadangan sebelum reversal. Jalur reversal kemudian INSERT langsung pada `accounting-journal.service.ts:1441`; tidak ada pemeriksaan sumber kedua.
- Setelah reversal, `accounting-petty-cash.service.ts:759` menghitung baris reversal langsung bersama jurnal asli. Neto pada snapshot A menjadi nol dan cadangan pokok kembali tertahan. Ini membatasi temuan pada pelanggaran penguncian sumber/409, bukan klaim kas tersedia terbuka kembali.

## Penutupan ronde 8 dan pemeriksaan lain

- **P1-1 ronde 8:** remap A→akun baru B tidak lagi melewati snapshot; sumber dikenal dengan snapshot NULL/absen diperiksa langsung (`accounting-journal.service.ts:1134–1151`). Cadangan dan gerbang kini menghitung reversal langsung. Skenario pembukaan kas tersedia ronde 8 tertutup secara statis; variasi remap ke akun debit historis masih melanggar guard 409 sebagaimana P2-1 di atas.
- **P2-1 ronde 8 tertutup secara statis:** impor mengambil kunci chart berurutan sebelum `tenants FOR UPDATE` (`tenant-config.service.ts:494–510`). Handler membaca ulang entity dan memakai `pg_try_advisory_xact_lock` dengan kunci identik sebelum validasi/INSERT (`tenant-config-finance.ts:406–425`, `tenant-config-locks.ts:62,78`). Gagal try-lock melempar `ConfigImportError` dan rollback; tidak ditemukan bypass konkret. Test baru meliputi impor dahulu, mapping dahulu, dan akun berbeda. Kasus entity muncul di antara dua pembacaan belum diuji oleh test baru; ini batas cakupan, bukan temuan tersendiri.
- **P2-2 ronde 8 tertutup secara statis:** NULL/key hilang/bukan JSON angka/≤0 dipilih sebelum filter neto (`accounting-petty-cash.service.ts:764–765,795,822`; `1118-shared-cash-mapping.sql:53–54,65–66,106–107`). Nominal tidak terbaca ditahan menurut total debit jurnal asli (`accounting-petty-cash.service.ts:717–723,761`). Gerbang menghitung reversal pada SQL `:91–98`.
- Reversal berantai dan lintas entity ditolak untuk data sah oleh unique index, `assertReversible`, dan trigger `0272_depreciation_journal_manual_reverse_guard.sql:58–64`; penjumlahan reversal langsung tidak memerlukan rekursi untuk jalur tersebut. Tidak ditemukan bypass tambahan dari pemanggil reversal sistem yang ditelusuri. Jurnal manual/koreksi umum tidak dilaporkan ulang sebagai cara menciptakan saldo.
- Test nominal baru mencakup kasbon/reimburse, nominal rusak, jurnal sehat, reversal, dan penolakan pembayaran kedua. Perubahan helper fixture hanya menambah opsi akun debit dengan default lama tetap. Test remap memakai akun tujuan baru; belum mencakup tujuan akun debit jurnal lama seperti temuan P2-1.

## Batas verifikasi dan perubahan

- Memakai `git diff`, `git show`, pencarian referensi, serta pembacaan test pada head terpin; tidak memakai isi checkout utama sebagai pengganti kode review.
- Tidak menjalankan test database, build, migrasi, atau layanan. Hasil test cabang tidak diklaim sebagai hasil pengujian sesi ini. Semua klaim penutupan di atas dibatasi pada pemeriksaan statis.
- `pnpm exec prettier --check docs/qa/second-opinion-kas-ronde9-1142.md` dicoba dan keluar 1: modul `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi untuk review ini. Pembacaan ulang laporan memastikan SHA dan temuan tercantum; `git diff --no-index --check /dev/null <laporan>` tidak menghasilkan diagnostik whitespace (exit 1 karena berkas baru).
- Hanya laporan ini ditulis di folder utama. Tidak checkout, membuat worktree, mengubah kode/status Beads, commit, push, merge, atau menghapus berkas.
