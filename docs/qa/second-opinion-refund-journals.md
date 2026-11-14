# 770 — Second opinion rantai refund journal

Tanggal: 14 November 2026. Peran: second-opinion Codex, read-only terhadap kode. Worktree: `legend-d6653a71`, cabang saat diperiksa: `ghostex/d6653a71`, HEAD `0df6d5e096401ac1e0dfc3c125548f9a58939881`.

## Ruang pemeriksaan dan hasil

Rentang yang diminta: `git diff milestone/m1...origin/ghostex/refund-pin-earlierintentwant-per-key`; merge-base `7745e40e35c12b52fdfce3b65220cb01fa797ee0`. Rantai diperiksa sebagai satu alur: `cda602bc1` → `dba3f40b3` → `af0edffd2` → `0df6d5e09`, termasuk perubahan refund di commit antara `e4664b020` dan `f165451d1`. Perubahan domain lain yang diwarisi rentang tersebut tidak menjadi objek review ini.

Tidak ditemukan jalur pembayaran produksi berlebih yang terkonfirmasi. Ada dua gap batas sumber pada fallback, direproduksi dengan test integrasi sementara: jurnal refund dapat mengkredit `customer_deposit` Rp50.000 terhadap pin intent Rp40.000. Kedua jurnal tetap seimbang. Ini bukti kesalahan atribusi/batas kewajiban pada fixture sumber tidak lengkap, bukan bukti transfer Rp50.000 benar-benar terjadi.

Kedua temuan diberi **P2, bersyarat pada data legacy/tidak lengkap**. Fixture merekayasa metadata POS dengan sale kas Rp55.000 dan pin/receipt gateway Rp40.000, mengikuti pola ARR-11/12 yang sudah ada. Kombinasi ini tidak dibuktikan bisa dibuat melalui API normal sekarang; belum dibuktikan pula ada pada data produksi historis. Batas ini penting saat menilai prioritas. Total sale melebihi pin sendiri dapat sah, misalnya QR Rp55.000 dengan DP Rp15.000 dan pembayaran residual Rp40.000 (`qr-order-payment.ts:185`), tetapi producer normal tetap membatasi refund residualnya.

## Temuan 1 — Recovery tanpa source mengabaikan kewajiban sebelumnya

**P2 — `apps/api/src/services/accounting-auto-journal-amounts.ts:1163` dan `:1204`; terkait `legend-zwaro`.** Saat `recoveryWithoutSource` benar, perhitungan `earlierUnfiledIdr` dilewati dan `earlierGatewayIdr` diganti nol. Perbaikan per key/per intent pada rantai ini belum melindungi cabang recovery tersebut.

- **Skenario yang dijalankan:** Sale Rp55.000, pin intent sudah dibayar Rp40.000, receipt posted, tanpa tender gateway yang membuktikan sumber. Refund POS Rp30.000 sudah dijurnal. Dua variasi diuji: line menyimpan intent yang sama tetapi payment refund berstatus `failed`; atau line legacy tanpa intent dan tanpa payment refund. Berikutnya ada refund recovery Rp20.000 dengan row `order_issues` nyata dan tanpa row `payment_refunds`.
- **Hasil aktual:** Refund pertama dan recovery sama-sama `posted`; kredit refund ke `customer_deposit` berjumlah Rp50.000. Kedua jurnal memiliki debit = kredit. Batas pin hanya melihat Rp20.000 + filed Rp0, sehingga melewatkan kewajiban Rp30.000. Kelebihan terhadap batas sumber yang dipilih sebesar Rp10.000.
- **Hasil yang dibutuhkan:** Recovery diparkir `AUTO_JOURNAL_REFUND_SOURCE_PENDING` selama Rp30.000 + Rp20.000 melebihi Rp40.000, atau sampai sumber/sisa kapasitas yang benar terbukti.
- **Test yang sudah ada:** `refund-split-journal-fallback.test.ts:1121` (RSJ-11) hanya menghitung refund sebelumnya yang telah filed/nonfailed. `auto-journal-refund-residual.test.ts:1112`, `:1156`, `:1258`, `:1532`, dan `:1660` menguji failed/short/DP tetapi memakai UUID refund kedua tanpa row `order_issues`; `recoveryWithoutSource` tetap false. Test tersebut tidak menangkap temuan ini.
- **Bukti baru:** Dua test scratch dengan row issue nyata gagal pada assertion `50000 <= 40000`; lihat `/tmp/refund-770-scratch/recovery-zwaro.test.ts:821` dan `/tmp/refund-770-zwaro-tests.log:28`.
- **Arah perbaikan:** Hitung kewajiban pada pinned intent juga untuk recovery fallback. Pertahankan offset per key hanya untuk bagian yang benar-benar covered oleh payment refund nonfailed pada intent yang sama. Jika hubungan sumbernya belum terbukti, parkir.

**Penilaian `legend-zwaro`:** Pertahankan terbuka untuk koreksi batas kewajiban/jurnal fallback dan tambahkan regresi dengan issue nyata. Bukti yang diperoleh belum mendukung klaim P1 pembayaran produksi berlebih. Producer sekarang merutekan order POS kembali ke refund POS (`order-recovery-refund.ts:242`), membuat event dan payment refund dalam transaksi yang sama (`:580`, `:595`, `:627`), dan membatasi refund ke `total − deposit − released` (`order-recovery-refund-amount.ts:225`). Tidak ada bukti bahwa kegagalan biasa di antara append event dan insert refund meninggalkan orphan setelah commit.

## Temuan 2 — Refund payload-only sebelumnya tidak mengurangi kapasitas pin

**P2 — `apps/api/src/services/accounting-auto-journal-amounts.ts:1027`, `:1141`, dan `:1202`.** Daftar `earlier` hanya berasal dari `pos_order_refunds`; jumlah `filed` hanya berasal dari `payment_refunds`. Refund sebelumnya yang hanya memiliki event/jurnal tidak masuk keduanya. Pemeriksaan pin tidak menjumlahkan kewajiban jurnal payload-only yang sudah posted.

- **Skenario yang dijalankan:** Fixture sale/pin/receipt sama seperti temuan 1. Dua event refund payload-only memakai ID berbeda, Rp30.000 lalu Rp20.000, tanpa row POS refund, payment refund, atau issue. Refund pertama sudah posted sebelum kedua diproses.
- **Hasil aktual:** Keduanya posted dan seimbang; kredit refund ke `customer_deposit` Rp50.000. Masing-masing Rp30.000 dan Rp20.000 lolos batas individual Rp40.000. Cap sale Rp55.000 tidak menolak total Rp50.000, sedangkan pin tidak mengetahui jurnal refund pertama.
- **Hasil yang dibutuhkan:** Refund kedua diparkir karena sisa sumber Rp10.000, atau karena sisa kapasitas sumber tidak dapat dibuktikan. Idempotensi per refund ID tidak mencegah kasus dua ID berbeda ini.
- **Test yang sudah ada:** ARR-8 (`auto-journal-refund-residual.test.ts:1024`) menguji satu payload-only. ARR-9/11/12 mengawali kasus dengan row POS refund/payment refund. Tidak ada test tracked untuk dua refund payload-only berbeda dengan source rows tidak lengkap.
- **Bukti baru:** Test scratch ketiga gagal pada assertion `50000 <= 40000`; lihat `/tmp/refund-770-scratch/recovery-zwaro.test.ts:855` dan `/tmp/refund-770-zwaro-tests.log:47`.
- **Arah perbaikan:** Buktikan kapasitas sumber secara kumulatif untuk fallback payload-only, dengan deduplikasi terhadap filed/POS obligations. Bila atribusi jurnal lama ke intent tidak dapat dibuktikan, parkir. Menghapus pengecualian recovery pada temuan 1 saja tidak menutup kasus ini karena row POS sebelumnya memang tidak ada.

## Idempotensi, race, dan perlindungan uang yang diperiksa

- **Key jurnal yang sama:** Advisory lock dan pengecekan jurnal sebelumnya ada di `accounting-auto-journal-consumer.ts:401`. AJ-2JYR-10 (`accounting-auto-journal-refund-split.test.ts:1276`) lulus untuk replay, concurrent delivery refund yang sama, dan sweep; satu jurnal saja.
- **Dua refund ID berbeda:** `refundComponentsOf` mengambil lock per tenant/order sebelum membaca cap dan menahannya sampai jurnal posted (`accounting-auto-journal-tax-split.ts:335`). Test scratch bersamaan Rp60.000 + Rp60.000 terhadap sale Rp100.000 menghasilkan satu `posted` dan satu `parked/AUTO_JOURNAL_PAYLOAD_INVALID`. Tidak ditemukan race yang melewati cap sale.
- **Key pengajuan gateway:** `pos-refund-gateway.ts:47` memakai refund ID + intent ID. Helper mengunci intent (`:98`) dan membatasi pengajuan ke `cap − reserved` (`:131`). DP + line pada intent yang sama ditolak sebelum menulis (`:85`); dua test guard di `pos-refund-gateway-autofile.test.ts:897` dan `:919` lulus.
- **Offset sebelumnya:** Perhitungan per key menggabungkan line + DP; hanya payment refund nonfailed pada pinned intent yang sama mengurangi want (`accounting-auto-journal-amounts.ts:1153`). Test failed/shortfall dan intent lain lulus. Tidak ditemukan hitung ganda baru pada perubahan `0df6d5e09` itu sendiri.
- **Keseimbangan jurnal:** Pembagian akhir memenuhi `depositIdr + clearingIdr = gatewayIdr` (`accounting-auto-journal-amounts.ts:1235`). Test mixed/refund split lulus. Dua temuan di atas tetap menghasilkan jurnal seimbang; kesalahan ada pada batas sumber/kewajiban.
- **Pembayaran nyata:** Approval menguji ulang `refundableBalance` dan menggagalkan refund yang melewati cap (`payment-refund.service.ts:499`). Kelebihan kredit jurnal pada scratch tidak membuktikan bypass guard pembayaran ini.

## Verifikasi yang benar-benar dijalankan

Worktree disiapkan melalui `node scripts/worktree-setup.mjs`; tidak menjalankan aplikasi/dev database. Semua test memakai PostgreSQL disposable dan seluruh container/network milik run sudah dibersihkan.

```sh
LEGEND_TEST_FILES="src/test/refund-split-journal-fallback.test.ts src/test/auto-journal-refund-residual.test.ts src/test/accounting-auto-journal-refund-split.test.ts src/test/pos-refund-gateway-autofile.test.ts" heavy pnpm test
```

Hasil: **4 berkas, 62 test lulus, exit 0**, durasi Vitest 16,13 detik. Log: `/tmp/refund-770-focused-tests.log:114`.

Reproduksi tambahan berada di luar repo. Wrapper `/tmp/refund-770-scratch/run-test.mjs` menyiapkan DB disposable lalu menjalankan Vitest terarah melalui `heavy`:

```sh
LEGEND_TEST_FILES=/tmp/refund-770-scratch/recovery-zwaro.test.ts node /tmp/refund-770-scratch/run-test.mjs unit
```

Command test di dalam wrapper:

```sh
heavy pnpm --filter @starter/api exec vitest run --config=/tmp/refund-770-scratch/vitest.config.ts /tmp/refund-770-scratch/recovery-zwaro.test.ts
```

Hasil: **3 test gagal pada invariant cap yang sedang dibuktikan, 1 kontrol race lulus, exit 1**, durasi 2,16 detik. Ketiga kegagalan adalah assertion Rp50.000 ≤ Rp40.000, bukan error setup. Log: `/tmp/refund-770-zwaro-tests.log:97`. Scratch/log berada di `/tmp`, sehingga bukan artefak permanen repository.

Tidak menjalankan full `pnpm check`, build, e2e, atau gateway sungguhan karena ini review tanpa perubahan kode. Tidak memverifikasi keberadaan keadaan orphan tersebut pada data produksi historis, maupun race callback penyedia pembayaran. Tiga subagent membagi review sumber/split, residual/key, dan coverage/reproduksi. Tidak ada kode/test tracked, status Beads, commit, merge, atau push yang diubah; satu-satunya berkas repo yang ditambahkan adalah laporan ini.
