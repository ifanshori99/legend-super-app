# Second opinion payout — gerbang rilis uang, brief 869

## Peta berkas dan rentang commit

Audit pada 15 November 2026. `git fetch origin` selesai sebelum ref dibekukan pada 09:01 WIB. Seluruh nomor baris di bawah merujuk basis `46f9d1bca726073b91e899f40987e3d37c313ef9`, kecuali disebutkan SHA lain. Pemeriksaan memakai `git show`/`git diff`; checkout folder utama tidak diubah. Hanya laporan dan catatan progress yang ditulis di worktree audit.

| Ref yang diminta | Tip setelah fetch (lokal = origin) | Rentang efektif terhadap basis |
| --- | --- | --- |
| `origin/milestone/m1` | `46f9d1bca726073b91e899f40987e3d37c313ef9` | Basis audit |
| `ws/payout-api-gaps` | `adde2aebe99a1cc2637653ca0ee75ec2c237555b` | Sudah ancestor basis; `tip..basis` 247 commit, `basis..tip` kosong |
| `ws/payout-followups` | `6574cb40f07ced4e69600b972c9d849d4cee527f` | Sudah ancestor basis; `tip..basis` 242 commit, `basis..tip` kosong |
| `ws/payout-approval-followups` | `172a26c777db80031a19f0521d0d2e53cde2f09d` | Sudah ancestor basis; `tip..basis` 234 commit, `basis..tip` kosong |
| `fix/payout-approval-confirm-binding` | `a9657bd3705f80e766a9968a23967dc761077795` | `172a26c777db80031a19f0521d0d2e53cde2f09d..a9657bd3705f80e766a9968a23967dc761077795`, 1 commit unik; 234 commit basis tidak ada di cabang |
| `fix/payout-cors-expose-headers` | `d4f3b4c3b82ea015f12a54ddbcbe11276532f9b6` | Sudah ancestor basis; `tip..basis` 281 commit, `basis..tip` kosong |
| `ui/payout-wiring` | `f47c6536c28f35e80d497339f53646247b110225` | Sudah ancestor basis; `tip..basis` 240 commit, `basis..tip` kosong |
| `ghostex/pemindai-bersama-bukti-payout-m6` | `53b0db3934b31cb62fd403cb789c600866220621` | `b42619abce5d326d547c4ae17293adca970db99e..53b0db3934b31cb62fd403cb789c600866220621`, 6 commit unik; 132 commit basis tidak ada di cabang |

Jumlah tertinggal mencakup perubahan domain lain, bukan jumlah commit payout. Cabang antrean diperiksa sebagai delta dari merge-base, sehingga snapshot cabang yang lebih tua tidak dianggap menggantikan perbaikan yang sudah ada di basis. Tidak membuat merge integrasi atau menjalankan hasil gabungannya.

| Area | Berkas yang dipetakan |
| --- | --- |
| Siklus batch, jumlah, hash, approval, pencegahan percobaan ganda | `apps/api/src/services/payroll-payout.service.ts` (`createDisbursementBatch:699`, `submit:1062`, `approve:1177`, `cancel:1317`) |
| Ekspor manual, konfirmasi, resolve dua orang, return, serah terima tunai | `apps/api/src/services/payroll-payout-manual.service.ts` (`export:154`, `confirm:659`, `resolve:795`, `return:966`, `cash:1102`) |
| Jurnal GL per item, biaya, return, event run paid, repost biaya | `apps/api/src/services/payroll-payout-gl.service.ts` (`settle:176`, `return:340`, `paid:401`, `repostFees:490`) |
| Kasus kelebihan bayar dan pencabutan proposal resolve | `apps/api/src/services/payroll-payout-overpaid.service.ts`, `payroll-payout-withdraw.service.ts` |
| Konfigurasi sumber, setup, daftar batch | `apps/api/src/services/payroll-payout-config.service.ts`, `payroll-payout-setup.ts`, `payroll-payout-batch-list.service.ts` |
| Batas penyedia disbursement | `apps/api/src/services/payroll-payout-provider.ts` |
| Upload, pembatasan key tenant/batch, pemeriksaan objek, pembacaan bukti | `apps/api/src/services/payroll-payout-evidence-upload.service.ts`, `payroll-payout-evidence.ts`, `payroll-payout-evidence-read.service.ts` |
| Route payout dan bukti | `apps/api/src/routes/payroll-payout.routes.ts`, `payroll-payout-return.routes.ts`, `payroll-payout-evidence.routes.ts` |
| Schema dan penjaga DB | `apps/api/src/db/schema/payroll-payout.ts`; migrasi `0344_payroll_disbursement_batches_items.sql`, `0348_payout_gl_postings.sql`, `0351_payout_return_two_person_guard.sql`, `0355_payout_source_bank_frozen.sql`, `0367_payout_resolution_withdraw_guard.sql` dan amandemennya |
| Penghasil/pengonsumsi event GL payroll | `apps/api/src/services/payroll-run-lock.service.ts`, `payroll-events.ts`, `operations-events.ts`, `core-outbox.ts`, `payroll-gl-consumer.ts`, `apps/api/src/worker-main.ts` |
| Jalur ekspor bank lama yang masih terpasang | `apps/api/src/routes/storage-api.routes.ts:175`, `payroll-export.routes.ts:49`; `apps/api/src/services/payroll-export.service.ts:409`; `apps/api/src/lib/payroll-export/bank-formats.ts:165` |
| Kontrak dan posting rules | `packages/shared/src/validators/payroll-payout.ts`, `packages/shared/src/hris/payroll/payout-endpoints.ts`; aturan jurnal `payroll.locked`/`payroll.paid` di paket shared |
| Delta konfirmasi UI yang masuk cakupan khusus | `apps/web/src/features/ws10-payroll-payout/components/approval-tab.tsx` pada `a9657bd3`; hanya binding konfirmasi, tanpa audit visual/UI umum |
| Delta scanner yang relevan | Upload bukti pada `53b0db39`, pipeline `core-storage*`, `core-image`, `clamd-scanner`, `pdf-safety*`; tidak mengubah konsumsi bukti atau transaksi payout |

Riwayat payout relevan yang sudah termasuk basis: `5c73da044` (core/manual), `83892702e` (GL/biaya/return), `28ef0a347` (hardening/overpaid), `323131122` dan `6389feeb4` (sumber/biaya), `acd95cfb6` dan `69fcf8a09` (rekening beku), `adde2aebe` (upload/snapshot/daftar), `2633c2195` (proof resolve/storage), `ce1ff6298` (bukti tunai), `8df248c5f` dan `6574cb40f` (withdraw/audit), `172a26c77` (sumber approval/password upload).

Delta unik scanner: `d4c02fa0a` → `adb1b107b` → `ec1b06495` → `f93f33660` → `ba10ec7f4` → `53b0db393`. Delta unik binding: `a9657bd37`.

## Hasil

Ditemukan **2 P1 dan 1 P2** yang tetap berlaku setelah memperhitungkan seluruh delta antrean. Tidak ada P0/P3 konkret yang dilaporkan. Rekomendasi: tahan gerbang rilis uang sampai dua P1 ditutup dengan test regresi; tutup pula kontrak penggunaan ulang bukti P2 agar tidak menganggap bukti tersimpan sebagai bukti dana yang unik.

### P1 — Settlement gaji hilang ketika consumer payroll.locked terlambat

`apps/api/src/services/payroll-payout-gl.service.ts:212` — **`legend-2aspe`**. Ketiadaan jurnal lock saat konfirmasi diperlakukan permanen sebagai `settle_skipped`, termasuk ketika akuntansi aktif dan event lock hanya belum dikonsumsi.

- **Skenario gagal:** Aktifkan akuntansi, tunda worker, kunci payroll tunai net Rp1.000.000, lalu buat/ajukan/setujui batch dan konfirmasi serah terima melalui orang yang sah. Tidak diperlukan bypass izin. Penguncian payroll hanya mengantre event (`payroll-run-lock.service.ts:701`, `core-outbox.ts:111`); consumer berjalan terpisah (`worker-main.ts:374`). Status `locked` sudah cukup untuk pembuatan batch (`payroll-payout.service.ts:725`).
- **Rantai akibat:** Settlement melihat belum ada jurnal lock, menyimpan `settle_skipped`, lalu mengisi `glPostingId` item (`payroll-payout-gl.service.ts:287`, `:310`). Setelah worker dilanjutkan, `payroll.locked` mengkredit utang gaji Rp1.000.000. Event paid selalu membawa `settledPerItem: true` (`:447`) sehingga consumer melewatinya (`payroll-gl-consumer.ts:308`). Pemanggilan settle ulang juga melewati item karena hanya memilih `glPostingId IS NULL` (`payroll-payout-gl.service.ts:195`).
- **Dampak uang/GL:** Uang tunai sudah diserahkan, tetapi kredit kas untuk gaji Rp1.000.000 hilang dan utang gaji Rp1.000.000 tetap terbuka. Masing-masing jurnal yang ada dapat seimbang; total pencatatan tetap tidak cocok dengan pembayaran. Endpoint repost hanya menangani biaya, bukan pokok gaji.
- **Usul perbaikan:** Bedakan event lock yang masih tertunda dari payroll yang memang dikunci tanpa akuntansi. Simpan settlement tertunda dan selesaikan secara idempoten ketika jurnal lock tersedia; jangan tandai final hanya karena consumer belum berjalan.
- **Usul test:** Di `payroll-payout-gl.test.ts`, konfirmasi sebelum `W.postLockedJournal`, kemudian proses event locked dan paid, lalu ulangi settle. Pastikan saldo utang gaji nol, kredit kas tepat Rp1.000.000, dan tidak ada jurnal ganda. Test `settle-skipped` yang ada (`:473`) tidak mengirim lock terlambat sehingga belum membuktikan kasus ini.

### P1 — Ekspor bank lama melewati approval payout pada payroll baru

`apps/api/src/routes/payroll-export.routes.ts:49` dan `apps/api/src/services/payroll-export.service.ts:435` — **`legend-yjbjb`**. Endpoint lama masih terpasang dan hanya meminta `payroll.lock`; tidak meminta approval batch payout, binding sumber/hash, atau step-up payout.

- **Skenario gagal:** Pengguna dengan `payroll.lock`, tanpa izin menyetujui payout, membuat `POST /api/hris/payroll/runs/:id/bank-transfer-files` dengan `format: generic_csv` pada run baru berstatus `locked` yang belum memiliki batch bank. Endpoint menghasilkan berkas berisi rekening dan net pay. Formatter `generic_csv` benar-benar tersedia (`apps/api/src/lib/payroll-export/bank-formats.ts:165`); penundaan layout BCA tidak menutup jalur ini. Service hanya menolak bila sudah ada batch non-tunai non-cancelled (`payroll-export.service.ts:442`), tanpa batas run lama/cutover. Desain justru mewajibkan batch manual diajukan dan disetujui (`docs/design/payroll-disbursement.md:294`).
- **Varian yang merusak settlement:** Run campuran bank Rp3.000.000 dan tunai Rp2.000.000 memiliki batch tunai disetujui. Ekspor bank lama masih diizinkan; bayar bank memakai berkas itu, lalu konfirmasi tunai. GL per item mencatat Rp2.000.000 tunai saja. Run tidak dapat selesai karena pemeriksaan seluruh slip hanya mengenali item payout `succeeded` (`payroll-payout-manual.service.ts:490`). Batch bank baru ditolak karena berkas lama sudah ada (`payroll-payout.service.ts:772`); perubahan langsung status run ke paid juga ditolak oleh trigger bila ada batch non-cancelled (`apps/api/drizzle/0344_payroll_disbursement_batches_items.sql:516`). Implementasi endpoint mark-paid lama tidak ditemukan; keberadaan kontraknya tidak dianggap sebagai jalur pemulihan. Pembayaran bank Rp3.000.000 tidak memiliki jalur settlement aplikasi yang normal.
- **Dampak dan batas klaim:** Berkas pembayaran run baru dapat keluar sebelum approval yang diwajibkan, dan kombinasi kanal lama/baru dapat meninggalkan pembayaran bank tanpa jurnal settle. Ini bukan klaim API mengirim uang otomatis dua kali. Mengulangi ekspor dengan idempotency key baru juga masih dimungkinkan, tetapi perilaku dedupe bank eksternal tidak diuji.
- **Usul perbaikan:** Tutup pembuatan ekspor lama untuk run baru atau alihkan seluruh ekspor pembayaran melalui batch yang telah disetujui. Jika akses arsip lama diperlukan, pisahkan unduhan arsip dari pembuatan instruksi pembayaran baru; cegah kombinasi settlement legacy dengan batch tunai.
- **Usul test:** Pengguna `payroll.lock` tanpa approval payout harus ditolak mengekspor run baru. Uji run campuran tunai/bank agar kedua kanal wajib melewati gerbang dan seluruh nominal terjurnal tepat sekali. Sesuaikan test lama `payroll-payout-manual.test.ts:1512` yang justru mengharapkan kompatibilitas jalur ini; masalahnya kontrak keselamatan yang belum lengkap, bukan sekadar test yang hilang.

### P2 — Bukti return dapat dikonsumsi ulang untuk operasi return berbeda

`apps/api/src/services/payroll-payout-manual.service.ts:1024` — **`legend-w3691`**. Pemeriksaan bukti menjamin objek ada di tenant/batch yang benar dan kedua orang memakai key yang sama, tetapi tidak mengikat dana dalam bukti ke satu operasi pengembalian.

- **Skenario gagal:** A dan B sudah dibayar pada batch yang sama; hanya dana A benar-benar kembali. Dua orang berwenang yang berbeda, bukan pembuat batch, menyelesaikan return A memakai bukti K, lalu memakai K yang sama dalam dua langkah return B. Ini memerlukan dua pemeriksa yang keliru/berkolusi; bukan bypass izin atau pembacaan storage tenant lain.
- **Rantai akibat:** `assertEvidenceKeyForBatchStored` hanya memeriksa lokasi dan keberadaan objek (`payroll-payout-evidence.ts:122`); pemeriksaan langkah kedua hanya membandingkan K dengan proposal masing-masing item (`payroll-payout-manual.service.ts:1026`). B menjadi `returned` (`:1037`) dan mendapat jurnal return (`:1077`), walaupun dana B belum kembali. Status returned keluar dari indeks satu percobaan hidup per slip (`db/schema/payroll-payout.ts:536`), sehingga B dapat masuk batch susulan dan menerima pembayaran kedua.
- **Lintas batch/tenant:** Key dari tenant/batch lain memang ditolak (`payroll-payout-evidence.ts:74`). Namun mengunggah ulang byte bukti yang sama menghasilkan UUID baru (`payroll-payout-evidence-upload.service.ts:176`; pada scanner `53b0db39` baris 177), sehingga tidak ada perlindungan identitas bukti terhadap pemakaian ulang lintas payout. Ini tidak membocorkan objek antar-tenant.
- **Usul perbaikan:** Ikat claim bukti ke identitas transaksi bank, himpunan item, dan total dana pengembalian; konsumsi claim secara atomik. Fingerprint unggahan membantu deteksi replay, tetapi bukan pengganti binding transaksi. Hindari constraint satu key per item: satu laporan hasil bank untuk beberapa baris memang sah (`docs/design/payroll-disbursement.md:296`). Deteksi lintas tenant harus mempertahankan kerahasiaan tenant lain.
- **Usul test:** Setelah return A dengan K selesai, coba dua langkah return B memakai K: harus ditolak, B tetap succeeded, jurnal return B kosong, dan batch susulan B ditolak. Tambahkan reupload byte identik lintas batch/tenant serta kontrol laporan multi-item yang sah.

## Kontrol yang diperiksa dan batas cakupan

- **Approval dan balapan pada jalur batch baru:** Pemeriksaan pembuat/penyetuju, hash konten, sumber rekening yang dikonfirmasi, lock run → batch → item, perubahan bersyarat pada status, dan indeks satu percobaan hidup telah diperiksa. Tidak ditemukan bypass baru yang konkret pada jalur ini. Ini hasil audit statis, bukan bukti test balapan lulus.
- **Binding konfirmasi UI:** Basis masih memiliki masalah checkbox/step-up berpindah konteks batch/hash yang sudah ditangani oleh `a9657bd37` (`legend-uzd4t`). Delta tersebut mengikat batch/hash/sumber yang dicentang dan me-remount per batch. Jangan melewatkan commit ini dari kandidat rilis. Tidak dihitung lagi sebagai temuan tersisa setelah seluruh antrean diperhitungkan.
- **Return/resolve paralel item yang sama:** Dua pelaku berbeda, kesamaan bukti antar-langkah, penguncian dan perubahan status bersyarat mencegah dua penyelesaian item yang sama. P2 di atas menyangkut bukti yang dipakai pada operasi/item berbeda.
- **GL:** Penguncian per batch, kunci jurnal idempoten, pokok dari nominal item tersegel, akun sumber beku, biaya, pembalikan return dan pencatatan overpaid diperiksa. Tidak ditemukan jurnal tidak seimbang tambahan yang konkret; P1 menunjukkan jurnal pembayaran yang hilang, bukan debit/kredit berbeda dalam satu jurnal.
- **Scanner antrean:** Pipeline PDF/scan mendahului penyimpanan. Temuan P2 tetap berlaku karena perubahan hanya pada pemeriksaan unggahan, bukan claim penggunaan bukti. Tidak ditemukan dampak uang tambahan yang konkret dari delta scanner.
- **Duitku:** `createDisbursementBatch` secara eksplisit menolak kanal `duitku` dengan `PAYOUT_CHANNEL_NOT_AVAILABLE` (`payroll-payout.service.ts:705`). Implementasi provider yang tersedia hanya fake; adapter payout produksi, worker pengiriman/status dan callback payout belum terpasang. `payroll-payout-duitku-todo.test.ts` masih memiliki 13 `it.todo`. Fail-closed ini bukan celah pembayaran ganda yang aktif, tetapi idempotensi disbursement/webhook Duitku nyata belum dapat dinyatakan terbukti. Jangan menganggap webhook penerimaan pembayaran sebagai implementasi webhook payout.

## Verifikasi dan tindak lanjut

- **Dilakukan:** Fetch, pembekuan SHA, pemeriksaan ancestry/rentang, pembacaan diff dan kode pendukung, pengecekan ulang rantai temuan oleh agent utama. Tiga subagent Codex membaca area approval, bukti, dan disbursement/GL secara paralel; puncak tiga aktif. Tidak ada subagent tambahan.
- **Validasi laporan:** Pemeriksaan otomatis mencocokkan 24 path/citation dengan SHA basis, kedelapan ref beku, jumlah temuan, dan urutan peta sebelum hasil. Pemeriksaan whitespace melalui `git diff --check` lulus. Prettier tidak dapat dijalankan: dependensi tidak tersedia di worktree audit dan executable di checkout utama merujuk modul yang tidak ada; tidak memasang dependensi untuk audit ini.
- **Tidak dijalankan:** Test, build, lint produk, browser, simulasi bank, sandbox Duitku, maupun merge kandidat. Tidak memakai `heavy`, tidak menyalakan layanan, tidak mengubah kode produk, tidak push/merge.
- **Pelacakan:** Audit `legend-1gj8d`; tindak lanjut `legend-2aspe` (P1 GL), `legend-yjbjb` (P1 legacy), `legend-w3691` (P2 bukti). Test yang diusulkan adalah pekerjaan perbaikan berikutnya, belum menjadi bukti lulus.
- **Metrik:** `session-usage.py` tidak menemukan transkrip sesi Codex; `parallel-report` membaca sesi Claude dan tidak mencakup subagent Codex audit ini. Biaya dan rata-rata paralel sesi ini tidak tersedia; jumlah/puncak tiga berasal dari pemanggilan subagent aktual.
