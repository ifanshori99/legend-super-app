# Second opinion payout GL 877

Audit statis 15 November 2026 pada `0173623ed1c2cc6b48a9fa957385d075a158a815..d1e259ed4200640989cd6e80e58ef76fc93d508a`. Nomor baris merujuk tip tersebut. Konteks: `docs/qa/second-opinion-payout.md`, `docs/qa/second-opinion-payout-870.md`, dan `docs/briefs/877-payout-p3-gl.md` dibaca dari checkout utama karena tidak semuanya ada di tip audit. Tidak mengubah kode produk.

**Hasil: 2 P1 dan 1 P2. Tahan gerbang rilis uang sampai P1 diperbaiki dan dibuktikan.** P2 adalah kelemahan guard database dengan prasyarat akses SQL aplikasi; bukan klaim adanya bypass lewat HTTP.

## P1 — Jurnal lock selesai, tetapi settlement dan biaya dapat tertinggal tanpa antrean pemulihan yang terlihat

`apps/api/src/services/payroll-payout-gl.service.ts:735` dan `:758` — Saat settlement berstatus `settle_skipped` tidak dapat dijurnal karena mapping biaya bank hilang atau sumber tidak dapat diposting, resolver melanjutkan tanpa mengubah status, sedangkan consumer tetap menyelesaikan jurnal lock dan event.

- **Skenario:** Konfirmasi transfer bank Rp1.000.000 dengan biaya Rp5.000 ketika akuntansi mati; sebelum `payroll.locked` dikonsumsi, nyalakan akuntansi dan hilangkan/nonaktifkan mapping `bank_charges`. Consumer memposting utang gaji lalu melewati settlement (`:735–753`); `payroll-gl-consumer.ts:332` tetap mengembalikan sukses dan `core-outbox.ts:412` menandai event delivered. Jurnal pokok dan biaya tidak ada, padahal uang Rp1.005.000 sudah keluar. Utang gaji Rp1.000.000 tetap terbuka. Hal yang sama untuk pokok terjadi bila akun sumber beku tidak postable (`:758–763`).
- **Pemulihan:** Posting skipped yang dibuat saat akuntansi mati mempunyai `fee_posted = true` (`:551–552`, `:633`), sehingga daftar finance `listSkippedFees` hanya mencari `false` (`:1163–1174`) dan tidak memperlihatkannya. Tidak ada retry otomatis setelah mapping pulih. Endpoint repost biaya memang memanggil resolver lebih dulu (`:1051–1057`), sehingga pemulihan manual jika batch sudah diketahui mungkin; tetapi daftar tersebut tidak mengarahkan finance ke batch ini. Test `apps/api/src/test/payroll-payout-877-gl-fee-skipped.test.ts:602` memulihkan dengan memanggil helper internal langsung (`:637`), bukan membuktikan pemulihan yang ditemukan pengguna/worker.
- **Usul:** Sesuai brief, jangan commit jurnal lock tanpa menyelesaikan settlement tersebut, atau buat kewajiban pemulihan yang tahan lama, terlihat, dan otomatis diulang; jangan sembunyikan biaya yang belum dijurnal sebagai sudah diposting. Pertahankan kunci idempoten dan jelaskan penanganan akun nonpostable.
- **Usul test:** Pakai outbox sungguhan, konfirmasi dengan akuntansi mati, hilangkan mapping biaya atau nonaktifkan sumber, konsumsi event, pulihkan konfigurasi, lalu jalankan hanya jalur worker atau pemulihan publik yang tersedia. Pastikan kegagalan terlihat, saldo 2103 benar, kredit sumber Rp1.005.000 tepat sekali, dan replay/paralel tidak menambah jurnal.

## P1 — Settlement kas dapat memakai akun baru, bukan sumber saat kas diserahkan

`apps/api/src/services/payroll-payout-gl.service.ts:403` dan `:525` — Untuk skipped cash, mapping saat serah terima disimpan hanya bila postable; bila kosong atau nonaktif, posting menyimpan `null`, lalu resolver memakai mapping pada saat pemrosesan (`:404–406`).

- **Skenario:** Saat akuntansi mati kas Rp1.000.000 diserahkan dari kas A, dan mapping `petty_cash` menunjuk A yang sedang nonaktif. Karena A tidak postable, posting mencatat sumber `null`. Finance kemudian memetakan kas ke B yang aktif; akuntansi dinyalakan dan consumer memproses lock. Resolver mengkredit B Rp1.000.000 walaupun uang keluar dari A. Utang gaji tampak lunas, tetapi saldo kedua akun kas salah. Skenario sama mungkin bila mapping belum ada saat serah terima dan sumber sebenarnya dibuktikan terpisah. Jalur bank legacy dengan `sourceBankAccountId = null` juga menggunakan konfigurasi saat ini (`:370–372`, `:416`), sehingga memerlukan penanganan sumber historis yang sama.
- **Usul:** Simpan identitas sumber saat penyerahan walau akun sementara tidak postable, dan jangan menggantinya dengan mapping baru. Bila identitas sumber tidak tersedia pada baris lama, tahan settlement untuk rekonsiliasi yang mencatat sumber sebenarnya; jangan menebak dari konfigurasi saat ini.
- **Usul test:** Serahkan kas dengan mapping A nonaktif, pindahkan mapping ke B, aktifkan akuntansi dan konsumsi lock; B tidak boleh dikredit. Uji juga sumber `null` dan bank legacy tanpa sumber beku, serta kontrol mapping A aktif yang berubah setelah serah terima. Pastikan penyelesaian setelah pemulihan tepat sekali.

## P2 — Guard menerima perubahan skipped menjadi settle tanpa jurnal

`apps/api/drizzle/0620_payout_skipped_settle_guard.sql:21` — Guard menerima perubahan `settle_skipped → settle` berdasarkan bentuk perubahan saja, tanpa memeriksa bahwa jurnal dengan `journal_key` posting ada. `apps/api/drizzle/0368_payout_pending_settle_return_claims.sql:40` sudah memberi role `legend_app` hak `UPDATE(kind)`.

- **Skenario dan batas:** Penulis SQL dalam konteks tenant pada role aplikasi, misalnya karena kesalahan kode masa depan, menjalankan `UPDATE ... SET kind = 'settle'` pada posting skipped tanpa membuat jurnal. Trigger menerimanya; resolver selanjutnya hanya memilih pending/skipped (`payroll-payout-gl.service.ts:711–717`), sehingga pokok tidak diposting lagi dan label settle palsu dapat memengaruhi return (`:902–915`). Tidak ditemukan endpoint HTTP yang melakukan update tersebut. Kelemahan yang sama untuk `settle_pending → settle` sudah ada sebelum diff; migrasi ini memperluasnya ke skipped.
- **Usul:** Tegakkan keberadaan dan keterkaitan jurnal settle di jalur transisi database atau batasi transisi melalui prosedur yang secara atomik membuktikan jurnal terkait, sambil mempertahankan isolasi tenant dan idempotensi.
- **Usul test:** Dengan role `legend_app` dan konteks tenant, coba flip tanpa jurnal yang cocok dan pastikan ditolak; buat jurnal yang benar dalam transaksi yang sama, pastikan flip sah, dan uji jurnal tenant/key lain serta perubahan kolom lain tetap ditolak.

## Pemeriksaan dan batas

- Diff, consumer, jalur fee repost, lock bukti, migrasi dan test terkait diperiksa secara statis. Tiga subagent Codex membaca area biaya, lock, dan guard/consumer secara paralel; puncak tiga aktif. Urutan fingerprint pada konfirmasi tidak menunjukkan deadlock baru yang konkret dalam cakupan ini.
- Dua temuan P1 memiliki skenario dalam jalur produk; temuan P2 memerlukan akses SQL role aplikasi. Tidak ditemukan P0 atau P3 konkret. Tidak menganggap belum adanya temuan lain sebagai bukti seluruh invariant uang aman.
- `git diff --check 0173623ed d1e259ed4` lulus. Pemeriksaan Prettier tidak tersedia karena dependensi tidak terpasang di worktree audit (`Command "prettier" not found`). Test produk, migrasi terhadap PostgreSQL, build, dan simulasi paralel tidak dijalankan; skenario dan usul test di atas belum merupakan bukti runtime. Tidak menggunakan `heavy` atau menyalakan layanan.
- Tindak lanjut: `legend-pfk3q` dan `legend-zlcsd` (P1), `legend-63qhw` (P2). Audit dilacak sebagai `legend-qu2of`.
