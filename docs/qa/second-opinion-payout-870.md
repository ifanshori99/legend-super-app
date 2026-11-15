# Second opinion ulang payout 870 — audit 872

Audit baca-saja pada 15 November 2026 untuk `legend-7t2vv`. Tidak mengubah kode produk, checkout utama, atau basis data aplikasi.

## Rentang dan keputusan

- Rentang diminta: `origin/ghostex/pemindai-bersama-bukti-payout-m6...origin/fix/payout-second-opinion-870`.
- Basis/merge-base beku: `53b0db3934b31cb62fd403cb789c600866220621`.
- Tip diperiksa: `9f75ea5583cfe846b8492f17dd3196880812095e`. Semua rujukan `berkas:baris` di bawah merujuk tip ini.
- Konteks awal: `docs/qa/second-opinion-payout.md`, dibaca dari disk checkout utama karena laporan itu tidak tercatat dalam tip perbaikan.
- Worktree laporan: `/Users/ifanshori99/Projects/legend super app/legend-review-872`, cabang `audit/payout-870-872`.

Hasil: **1 P1 dan 2 P2**; tidak ada P0/P3 konkret. Tahan gerbang rilis uang sampai skenario tersisa diperbaiki dan dibuktikan dengan test terarah. Satu dari tiga temuan awal tertutup penuh menurut pemeriksaan statis.

| Temuan awal | Hasil pemeriksaan ulang |
| --- | --- |
| `legend-2aspe` — settle saat consumer lock terlambat | Tertutup pada urutan normal: `settle_pending` diselesaikan oleh consumer dengan kunci idempoten. Belum penuh: perubahan modul accounting dapat meninggalkan pending tanpa jalur pemulihan normal (F1). |
| `legend-yjbjb` — ekspor bank lama tanpa batch disetujui | Tertutup pada jalur HTTP: POST selalu menolak `409 LEGACY_BANK_EXPORT_DISABLED`; tidak ditemukan caller produk alternatif pembuat file lama. GET arsip tetap tersedia sesuai kontrak. |
| `legend-w3691` — bukti return dipakai lagi | Tertutup untuk key yang sama, termasuk resolve/konfirmasi dan operasi paralel pada batch. Belum penuh: unggahan ulang bukti yang sama menghasilkan key baru dan claim baru (F2). |

## Temuan

### F1 — P1: modul accounting dimatikan membuat settlement pending kehilangan pemicunya

`apps/api/src/services/payroll-gl-consumer.ts:273`, terkait `apps/api/src/services/payroll-payout-gl.service.ts:480` — **`legend-2aspe` belum aman ditutup**. Consumer baru menyelesaikan pending setelah berhasil memposting jurnal lock, tetapi event lock masih boleh diabaikan menurut flag accounting saat consumer berjalan.

- Skenario gagal: Accounting aktif; worker ditunda; payroll tunai net Rp1.000.000 dikunci, batch disetujui dan serah terima dikonfirmasi. Settlement menjadi `settle_pending` (`payroll-payout-gl.service.ts:329`). Sebelum worker dilanjutkan, admin platform menghapus modul accounting lewat perubahan paket yang sah (`apps/api/src/routes/platform.routes.ts:230`; `apps/api/src/services/platform-org.service.ts:750`).
- Rantai akibat: Worker tetap memanggil consumer payroll (`apps/api/src/worker-main.ts:369`). `payroll.locked` bukan `followsLock`, sehingga consumer mengembalikan `ignored` tanpa jurnal dan tanpa resolver. `consumeOutbox` menganggap callback selesai, mencatat consumption dan menandai event `delivered` (`apps/api/src/services/core-outbox.ts:404`, `:412`).
- Dampak: Uang sudah diserahkan, tetapi jurnal pokok kas dan pengakuan/pelunasan utang gaji tidak ada. Mengaktifkan accounting lagi tidak memutar event delivered; settle/repost berhenti pada syarat jurnal lock (`payroll-payout-gl.service.ts:480`). Replay normal hanya menerima event dead-lettered (`core-outbox.ts:333`), sehingga pending ini tidak pulih lewat retry aplikasi. Ini bukan klaim bahwa karyawan otomatis menerima uang dua kali.
- Usul perbaikan: Fakta pending yang sudah tercatat harus mempertahankan kewajiban jurnal saat modul berubah. Proses lock dan pending terlepas flag terbaru, atau tahan event dalam keadaan yang dapat diulang; jangan konsumsi sukses tanpa menyelesaikan atau menjadwalkan pemulihan pending.
- Usul test: Handover sebelum lock journal → accounting off lewat API paket → konsumsi melalui `consumeOutbox` nyata → accounting on → retry normal. Pastikan pending akhirnya habis, kredit kas tepat Rp1.000.000, saldo utang gaji untuk run nol setelah lock/settle, dan replay tidak menambah jurnal atau pembayaran. Test baru `apps/api/src/test/payroll-payout-870-gl-pending.test.ts:147` hanya menguji flag tetap aktif dan memanggil helper consumer langsung.

### F2 — P2: unggahan ulang bukti return melewati claim

`apps/api/src/services/payroll-payout-manual.service.ts:1060`, terkait `:1095` — **`legend-w3691` belum tertutup penuh**. Identitas claim masih berupa path `evidenceKey`, bukan identitas transaksi dana kembali.

- Skenario gagal: A dan B telah dibayar; hanya dana A kembali. Dua petugas sah bukan pembuat batch menyelesaikan return A memakai PDF K. Unggah ulang PDF identik ke batch yang sama; upload membuat UUID/path K2 (`apps/api/src/services/payroll-payout-evidence-upload.service.ts:167`, `:177`). Dua petugas lalu menyelesaikan return B dengan K2.
- Rantai akibat: Lookup claim dan pemeriksaan resolve/konfirmasi hanya mencari key K2, sehingga tidak melihat konsumsi K. Claim baru dengan item-set B diterima; B menjadi `returned` (`payroll-payout-manual.service.ts:1228`) dan memperoleh jurnal return walau uang B tidak kembali. `returned` termasuk status retryable (`apps/api/src/services/payroll-payout.service.ts:88`, `:864`), sehingga B dapat masuk batch susulan dan dibayar lagi.
- Dampak: Penerima B memegang pembayaran pertama sekaligus pembayaran susulan; PT kehilangan net B dan biaya transfer susulan. Dua pemeriksa tetap diperlukan; ini tidak menembus autentikasi atau akses tenant.
- Bukti tambahan: Test baru `apps/api/src/test/payroll-payout-870-return-proof.test.ts:180` justru mengharapkan return B dengan key unggahan ulang bukti A diterima. Helper test memalsukan storage/key; test tersebut tidak membuktikan deduplikasi byte nyata. Masalah unggahan ulang sudah termasuk laporan dan deskripsi temuan awal.
- Usul perbaikan: Ikat claim pada identitas transaksi pengembalian, item-set dan total dana, lalu konsumsi atomik. Fingerprint berkas membantu menolak unggahan identik, tetapi bukan pengganti identitas transaksi; satu laporan bank sah untuk beberapa item harus tetap bisa diklaim bersama.
- Usul test: Unggah PDF identik dua kali melalui layanan upload nyata; sesudah return A dengan K, return B dengan K2 harus ditolak, B tetap `succeeded`, jurnal return B kosong dan batch susulan tidak memasukkan B. Uji pula replay lintas batch dengan unggahan baru serta kontrol satu laporan multi-item yang sah.

### F3 — P2: settlement tunai tertunda mengikuti akun kas yang baru

`apps/api/src/services/payroll-payout-gl.service.ts:241`, terkait `:515` — **`legend-cnpap`**. Pending settlement tunai tidak menyimpan akun sumber GL pada saat serah terima; resolver tidak memberi override untuk kanal cash.

- Skenario gagal: Mapping `petty_cash` menunjuk kas A. Worker ditunda; serah terima gaji tunai Rp1.000.000 dari kas A dikonfirmasi dan menghasilkan pending. Sebelum consumer lock berjalan, finance sah mengganti mapping `petty_cash` ke akun kas B yang aktif melalui `replaceAccountMappingsForEntity` (`apps/api/src/routes/accounting.routes.ts:171`; `apps/api/src/services/accounting-accounts.service.ts:291`, `:333`).
- Rantai akibat: Resolver memanggil posting rule `payout_cash` tanpa override sumber. Posting engine membaca mapping terbaru (`apps/api/src/services/accounting-journal.service.ts:576`); rule mengkredit `petty_cash` (`packages/shared/src/accounting/posting-rules.ts:512`). Kredit Rp1.000.000 masuk B, sedangkan kas A yang benar-benar berkurang tetap tampak utuh. Posting pending hanya menyimpan total/item-set, tanpa akun kas saat uang diserahkan (`payroll-payout-gl.service.ts:410`).
- Dampak: Pembukuan sumber kas salah meskipun jurnal seimbang dan utang gaji lunas. Ini tidak memindahkan uang ke rekening bank lain atau menyebabkan pembayaran otomatis tambahan; selisih kas A tertutup oleh penurunan kas B yang tidak terjadi.
- Usul perbaikan: Bekukan akun GL sumber tunai ketika handover membuat posting pending dan gunakan kembali saat resolver berjalan, sebagaimana sumber bank yang sudah diikat ke batch. Perubahan mapping untuk transaksi mendatang tidak boleh mengubah sumber transaksi yang sudah dibayar.
- Usul test: Handover pending dengan mapping A → ubah mapping ke B → konsumsi lock. Pastikan kredit A tepat net, B tidak berubah, pending menjadi settle, dan pengulangan consumer tidak menambah jurnal.

## Kontrol yang diperiksa dan batas klaim

- Penyelesaian ganda: Resolver memakai advisory lock per batch, posting `FOR UPDATE`, jurnal berkunci unik dan flip `settle_pending → settle` dalam satu transaksi (`payroll-payout-gl.service.ts:498`, `:512`, `:528`, `:533`). Return mengambil lock yang sama lewat settle sebelum mengubah item. Tidak ditemukan race konkret tambahan pada alur ini; ini bukan hasil test concurrency.
- Same-key claim lintas resolve/konfirmasi: Pemeriksaan claim dua arah berada setelah lock run → batch; key juga harus berada dalam folder tenant/batch yang sama. Dua request pada batch yang sama terserialisasi, dan konsumsi claim serta perubahan item berada dalam transaksi yang sama. Tidak ditemukan bypass same-key melalui resolve, konfirmasi atau batch susulan tanpa return yang diterima.
- Ekspor: `apps/api/src/routes/payroll-export.routes.ts:60` menolak sebelum pembuat file dipanggil. Service lama masih diekspor untuk pemakaian internal/test, tetapi pencarian caller produk tidak menemukan jalur aktif lain. Arsip lama dapat diunduh kembali; itu tidak dianggap pembuatan instruksi baru.
- Migrasi 0368: Claims memakai `app.enforce_tenant_rls` (`apps/api/drizzle/0368_payout_pending_settle_return_claims.sql:33`), yang memasang FORCE RLS dan restrictive USING/WITH CHECK tenant (`apps/api/drizzle/0001_tenant_rls.sql:45`). FK item memakai tenant/batch/claim bersama (`0368_payout_pending_settle_return_claims.sql:31`); guard claim membekukan pengikat dan hanya mengizinkan open → consumed (`:72`). Tidak ditemukan jalur tulis lintas tenant dari definisi ini. Tidak menjalankan migrasi atau uji role SQL.
- Batas pertahanan SQL: `return_claim_id` masih nullable, dan trigger item lama tidak mewajibkan claim untuk semua penulisan SQL langsung. Tidak dinaikkan menjadi bypass produk karena tidak ditemukan caller aplikasi yang memakai jalur itu; hasil ini tidak mengklaim semua penulis SQL tenant dipaksa melalui claim.
- Sumber bank pending: Lookup mempertahankan bank account yang dibekukan meskipun nonaktif. Hipotesis mengganti `bankAccounts.glAccountId` tidak dilaporkan karena tidak ditemukan jalur produk untuk mengubahnya.

## Verifikasi dan pelacakan

- Dilakukan: Pembekuan ref dan merge-base, pembacaan diff serta surrounding code yang diperlukan, pemeriksaan test regresi baru, penelusuran caller, dan verifikasi ulang rantai temuan oleh agent utama. Tiga subagent Codex memeriksa GL, return, dan ekspor/migrasi; total/puncak tiga.
- Validasi laporan: Rujukan lengkap berkas/baris dicocokkan dengan tip beku dan whitespace diperiksa lewat `git diff --cached --check`. Prettier dicoba tetapi tidak berjalan: executable checkout utama merujuk modul `prettier.cjs` yang tidak ada; tidak memasang dependensi untuk audit.
- Tidak dijalankan: Test produk, build, lint produk, migrasi, database, browser, bank/sandbox, atau `heavy`. Tidak mengubah kode produk dan tidak mengklaim skenario runtime sudah direproduksi. Test yang tercantum merupakan usul regresi.
- Pelacakan: Audit `legend-7t2vv`; F1 dicatat kembali pada `legend-2aspe`, F2 pada `legend-w3691`, F3 sebagai `legend-cnpap`. Status perbaikan lama tetap menunggu keputusan reviewer/CTO; laporan ini tidak menutup bug tersebut.
- Metrik: `session-usage.py` tidak menemukan transkrip sesi Codex; `parallel-report` hanya membaca sesi Claude lain. Biaya dan rata-rata paralel sesi ini tidak tersedia. Jumlah/puncak tiga berasal dari pemanggilan subagent aktual.
