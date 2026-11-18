# Second opinion POS kasir dan edge→cloud — 1111

Tanggal: 19 November 2026. Hasil: **1 temuan P2; tidak ada temuan baru P0/P1/P3**.

## Cakupan dan cara pemeriksaan

- Brief: `docs/briefs/1111-second-opinion-pos-edge-1096.md`.
- `git fetch origin` berhasil. Rentang yang diperiksa: `origin/ghostex/45769078...origin/ws/1096-pos-kasir-tiket-struk`, mengecualikan `:!**/meta/*snapshot.json`.
- Base/merge-base: `b8927ea90bfdef888bea4343ab68d4bedb26a780`; head: `92f4f2323ec52be802857908d23484bbfc90cef8`. Diff berisi 13 berkas, 2552 penambahan dan 20 penghapusan; fallback tidak diperlukan.
- Tiga subagent paralel memeriksa akses kasir, sale/void/replay offline, serta stempel/urutan lock. Pemeriksa utama memeriksa ulang rantai bukti temuan.
- Pemeriksaan statis melalui `git diff`/`git show`, tanpa checkout atau worktree. Nomor baris di bawah merujuk head tersebut. Pengecualian yang sudah diterima CTO dalam brief tidak dilaporkan ulang.

## Temuan

### P2 — ACK void belum menjamin run struk dapat diterapkan atau dipulihkan

`apps/api/src/test/pos-1096-receipt-edge-offline-void.test.ts:691` — Test memulihkan run yang ditolak dengan membuat event run baru secara manual, sedangkan reporter produksi tidak otomatis mengirim ulang run setelah ACK pengiriman. Jika ingest void mengalami kegagalan sementara, bukti struk bisa tetap hilang di cloud setelah void pulih. Ini celah baseline yang belum ditutup oleh bukti invariant 1096, bukan regresi perubahan stempel.

Skenario konkret:

1. Sale offline sudah berhasil di-ingest. Void offline memiliki receipt yang sah. Tahan lock loyalty tenant selama lebih dari dua detik saat cloud menerima `order.voided`.
2. `deliverSaleEffects` mengambil lock tersebut dengan batas dua detik (`apps/api/src/edge/order-ingest.ts:570`, `:579`), setelah insert void (`:783`, `:814`). Timeout `55P03` menggulung balik savepoint void. `ingestEdgeOrderVoided` menangkap error dan menyimpan alasan penolakan sementara (`:656`, `:669`), sehingga transaksi link tetap dapat selesai dan ACK dikirim. Hook berikutnya hanya menghitung ulang cost di bawah lock order (`apps/api/src/edge/order-edge-applier.ts:209`, `:211`, `:87`).
3. Sebelum sweep pemulihan void berjalan, reporter melihat outbox `order.voided` delivered dan queue acked sebagai tanda siap (`apps/api/src/services/edge-receipt-run-reporter.ts:117`). Reporter mengirim chunk yang berisi receipt void dan menaikkan high-water berdasarkan event yang sudah ditambahkan ke outbox (`:269`, `:385`, `:401`).
4. Cloud belum memiliki void yang cocok, sehingga run ditolak dengan `RECEIPT_VOID_UNMATCHED`, sebagaimana dibuktikan jalur penolakan pada test baru (`apps/api/src/test/pos-1096-receipt-edge-offline-void.test.ts:673`). Link mengubah penolakan domain menjadi conflict, mencatat event diterima, lalu memajukan cursor (`apps/api/src/edge/db-link-store.ts:817`, `:854`, `:864`). Penolakan ini tidak membuat sender mengantre ulang run.
5. Reporter juga dapat menambahkan event void `v:<ordinal>` pada pass yang sama (`apps/api/src/services/edge-receipt-run-reporter.ts:407`, `:445`). Jika event itu diterima sebelum void pulih, event itu ditolak pula. Pass berikutnya melewatinya karena kunci outbox sudah ada (`:412`).
6. Setelah lock dilepas, sweep meng-ingest ulang void dan membersihkan alasan penolakan (`apps/api/src/worker/edge-order-redrive.job.ts:218`, `:257`, `:305`). Sweep ini tidak menerapkan ulang run struk. High-water reporter tetap berasal dari event yang pernah ditambahkan, sehingga chunk awal tidak dikirim lagi. Test melewati kondisi produksi ini dengan `runEvent(...)` baru pada baris 696.

Dampak: Bukti struk di cloud tidak pulih otomatis; run berikutnya dapat tertahan oleh nomor yang belum tersinkron. Tidak ditemukan bukti pembayaran/refund ganda dari skenario ini. Severity P2 karena kegagalan memerlukan penolakan sementara dan urutan reporter mendahului sweep.

Usul perbaikan: Jadikan run yang menunggu ingest order/void sebagai pekerjaan yang dapat dicoba ulang setelah dependensinya pulih, dengan idempotensi yang sama. ACK transport perlu dibedakan dari keberhasilan ingest domain saat menentukan bahwa receipt sudah tersinkron.

Usul test: Pakai reporter produksi, outbox/link asli, dan sweep redrive. Ingest sale, tahan lock loyalty, kirim void sampai ACK, lalu kirim seluruh event run yang dihasilkan sebelum sweep. Lepaskan lock, jalankan sweep dan reporter kembali. Wajib seluruh receipt muncul di cloud dengan nomor tetap, satu void/jurnal pembalik, dan tanpa membuat event run pengganti secara manual. Test harus gagal pada jalur saat ini dan lulus setelah pemulihan run diterapkan.

## Area lain yang diperiksa

- Akses kasir: Guard autentikasi, origin, tenant, acting staff, dan shared device diterapkan pada rute baru (`apps/api/src/routes/facility-pos-ticket.routes.ts:145`, `:307`, `:325`, `:340`). Tidak ditemukan bypass konkret terhadap outlet path/acting staff.
- Privasi pelanggan: Projection SQL hanya `id` dan `name`, filter tenant, term literal, minimal tiga karakter, dan limit sepuluh (`apps/api/src/services/facility-pos-ticket-catalog.ts:56`, `:66`, `:70`, `:77`). Profil pelanggan memang didefinisikan per tenant dalam kontrak; produk/area/unit dibatasi tenant dan outlet. Tidak ditemukan kebocoran konkret di luar kontrak tersebut.
- Harga: Katalog mengambil harga produk server (`apps/api/src/services/facility-pos-ticket-catalog.ts:100`); sale menolak perbedaan harga baris POS dengan produk (`apps/api/src/services/facility-pos-ticket-sale.ts:228`).
- Replay/uang: Tidak ditemukan jalur tambahan uang atau receipt ganda pada merge/replay yang diperiksa.
- Stempel: Hanya kenaikan `lastNumber` pada run aktif yang terikat edge menulis stempel; waktu berasal dari jam aplikasi sesudah lock dan memakai `GREATEST` (`apps/api/src/services/pos-receipt.service.ts:1771`, `:1776`, `:1780`, `:1788`). Replay tanpa kenaikan nomor tidak mengubah stempel.
- Lock: Merge tetap mengambil advisory lock outlet lalu sequence perangkat `FOR UPDATE` menurut ID (`apps/api/src/services/pos-receipt.service.ts:1590`, `:1601`). Diff stempel tidak mengubah urutan tersebut. Tidak ditemukan deadlock database baru yang konkret dalam diff.

## Batas verifikasi

- Test, build, dan simulasi concurrency tidak dijalankan. Skenario P2 diturunkan dari rantai kode dan perlu test fault injection di atas; laporan ini tidak menyatakan test branch lulus.
- Format laporan lulus `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check docs/qa/second-opinion-pos-edge-1111.md`. Binary langsung dipakai karena entrypoint `pnpm exec prettier` checkout utama tidak tersedia (`MODULE_NOT_FOUND`).
- Hanya berkas laporan ini ditulis. Tidak mengubah source, menjalankan migrasi, commit, push, atau merge. Checkout utama tetap pada cabang semula `ux/customer-order-benchmark`.
