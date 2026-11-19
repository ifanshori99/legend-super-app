# Sub-brief 1199: fix SO 1197 edge catalog (kartu legend-7r7q6)

Cabang `ws/1199-edge-catalog-so1197` di atas `ws/1190-edge-catalog-hardening` (acf1edca3). Tingkat K (sync offline, harga). Tanpa migrasi bila bisa; bila perlu hanya 0726.
Temuan lengkap: `git show ux/customer-order-benchmark:docs/qa/second-opinion-edge-catalog-1197.md` (R1 P1, R2 P2, R3 P2; usul test T1-T3).

## Keputusan CTO (mengikat)
- R1/P1: sesudah rewind/restore, receipt versi lama tidak boleh menahan penerapan katalog. Freshness/checkpoint baru dilaporkan sukses SESUDAH katalog benar-benar diterapkan. Harga/menu edge tidak boleh tertinggal diam-diam. Replay HTTP lama dalam generasi sama tetap tidak boleh menimpa event lebih baru (perlindungan normal dipertahankan).
- R2/P2: sesudah restore, item yang tidak ada di snapshot cloud dinonaktifkan di edge (BUKAN dihapus; transaksi offline yang sudah mereferensikan item tetap sah). Jangan menyimpulkan ketidakhadiran dari satu halaman incremental; hanya dari snapshot lengkap multi-page. Tenant/outlet lain utuh.
- R3/P2: dedupe notifikasi tahan restart cloud: kunci stabil per edge + himpunan stream; boleh pakai notifikasi yang sudah ada sebagai penanda (durable). Satu notifikasi per heartbeat untuk episode baru; subset/reorder tidak menambah; `{A,B}` lalu restart lalu `{B}` = tetap 1; `{B,C@u}` menambah tepat 1.

## File kunci (acf1edca3)
- R1: `apps/api/src/services/edge-catalog-apply.ts` (resetCatalogSyncTxid ~540-581, filterCatalogRecordsAfterEvents ~535), `apps/api/src/edge/catalog-puller.ts` (~795-851 checkpoint/sukses), `apps/api/src/services/edge-catalog-sync.ts` (~199), `apps/api/src/edge/db-link-store.ts` (~119), `apps/api/src/services/edge-master-data-publisher.ts` (~155), `docs/deployment.md` (~413 runbook).
- R2: `edge-catalog-apply.ts`, `catalog-puller.ts`, `docs/deployment.md`.
- R3: `apps/api/src/services/edge-sync-conflict-alert.ts` (~343), `apps/api/src/edge/runtime.ts` (~289-303).
- Test existing: `apps/api/src/test/edge-catalog-epoch.test.ts`, `edge-catalog-stale-coalesce.test.ts`, `edge-catalog-rewind.test.ts`, `edge-catalog-cursor-marker.test.ts`, `edge-link-heartbeat-compat.test.ts`.

## Pemilik file (tidak bertumpuk)
- Test T1 (R1): `edge-catalog-epoch.test.ts` (tambah) - test-writer A.
- Test T2 (R2): file baru `edge-catalog-restore-membership.test.ts` - test-writer B.
- Test T3 (R3): `edge-catalog-stale-coalesce.test.ts` (tambah) - test-writer C.
- Implementasi: ditentukan sesudah peta Explore.

## Bukti selesai
Fail-first per temuan (merah di acf1edca3, hijau sesudah). Test edge-catalog-* + link-heartbeat hijau (`LEGEND_TEST_FILES=... heavy pnpm test`). Typecheck api sekali (heavy). `pnpm exec prettier --check` + `pnpm exec eslint` file berubah. Architect review. Commit, push, tutup kartu.

## Desain (CTO, tanpa migrasi)
Konstanta/kunci baru di `apps/api/src/db/schema/edge-node.ts` (union tipe `stream`; CHECK sudah `LIKE 'catalog:%'`, tanpa migrasi): `catalog:receipt-floor` dan `catalog:replay:${CatalogSyncStream}` (maks 40 char, sudah dihitung).

### R1 - receipt floor + rewind sentinel
- Rewind = watermark checkpoint `catalog:<stream>` bernilai sentinel `"rewind"` (export `CATALOG_REWIND_MARK` dari `catalog-puller.ts`), ATAU cursor ditolak cloud (rejectedCursor, sudah ada). `loadCatalogCheckpoint` sudah memberi cursor null untuk non-cursor; di tx halaman pertama (since===null) puller mengenali `current === CATALOG_REWIND_MARK` sama dengan rejectedCursor: `rewindFrom = current`.
- Pada rewind (di tx yang sama, SEBELUM resetCatalogSyncTxid): naikkan receipt floor per edge = `clock_timestamp()` ISO di checkpoint `catalog:receipt-floor` (monotonic; pakai saveCheckpointRow). Receipt `edge_inbound_events` dengan `received_at <= floor` TIDAK dihitung lagi sebagai "held" di: `heldCatalogEventVersions` (edge-catalog-apply.ts) dan `defaultLastSequence` cabang `kind==='master_data'` && `aggregateType==='catalog_record'` (db-link-store.ts). Fragmen SQL dibagi lewat modul kecil baru `apps/api/src/edge/catalog-receipt-floor.ts` (tanpa impor puller/transport, hindari siklus). Tanpa floor row = perilaku lama.
- Akibatnya reset menyentuh semua baris (termasuk yang dulu dilindungi receipt) dan filter tidak membuang rekaman restore; event link baru (sequence 201+) dan HTTP baru diterima; receipt SESUDAH floor tetap melindungi (HTTP lama tak menimpa event link lebih baru). Printer tombstone (`edgePrinterDeleteVersions`) ikut ter-reset.
- Freshness/checkpoint tetap ditulis hanya di tx yang sama dengan apply (sudah). Pastikan `saveCatalogCheckpoint` CAS rewindFrom bekerja dengan sentinel.
- Publisher cloud (`edge-master-data-publisher.ts`) tidak diubah: antrean cloud ikut ter-restore; catat di laporan.
- `docs/deployment.md` langkah 4 "Each edge database, rewind": ganti `SET watermark = NULL` menjadi `SET watermark = 'rewind'` (cursor lama NULL tetap jalan seperti sebelumnya, tapi tidak melepas receipt), jelaskan floor dan R2.

### R2 - nonaktifkan item hilang (soft)
- Pada tx halaman pertama rewind: upsert checkpoint `catalog:replay:<stream>` watermark `"1"` (penanda replay-penuh tertunda, tahan restart).
- Pada tx halaman TERAKHIR (`!page.hasMore`, bukan promosi parsial) bila penanda ada: panggil `deactivateAbsentCatalogRows(tx, {tenantId, stream, at})` lalu hapus penanda, dalam tx yang sama. Tidak jalan pada incremental / first boot / berhenti di maxPages (penanda bertahan; pull berikut yang menuntaskan).
- `deactivateAbsentCatalogRows` di file BARU `apps/api/src/services/edge-catalog-restore-membership.ts`: baris stream di tenant dengan `sync_txid = 0` (tidak tersentuh snapshot penuh sesudah reset) dinonaktifkan: `is_active=false` untuk tabel yang punya, kalau tidak `deleted_at = at` ; tidak pernah DELETE; hanya baris yang masih aktif. Streams: menu_items, item_variants, inventory_items, stations, menu_categories, modifier_groups, modifiers, price_lists, recipes (pakai kolom nyata di schema; lewati printers, promotions, vouchers, menu_item_modifier_groups bila tak ada kolom aman, dan catat di laporan). Scope per tenant (+ outlet/brand sesuai kolom tabel). Kembalikan jumlah baris.

### R3 - dedupe notifikasi per-stream durable
- Di `edge-sync-conflict-alert.ts`: marker per `(edgeNodeId, stream, staleSince)` yang durable lewat tabel `notifications` (kolom `dedupe_key` unik) atau `source_event_id`; sebelum kirim, buang stream yang sudah punya marker (query di tx). Sisa subset baru dikirim sebagai SATU notifikasi per heartbeat (id dari himpunan baru). Tulis marker per stream (juga bila tak ada penerima, agar episode tidak muncul lagi). Cache `catalogStaleAlerted` di runtime.ts jadi fast-path saja; clear() tidak lagi memicu alarm ulang.

## Ronde 2 (hasil run 1 + architect), keputusan CTO
Run 1: T1 cursor-rejected (T1a,b,c,d,f) MERAH dengan impl R1; T2 "cloud refuses stored cursor" merah; T3 eviction timeout 300s (cek di run sendiri; mungkin beban paralel).
Perbaikan wajib:
- A1 (R1): diagnosis kenapa jalur cursor-rejected (rejectedCursor) belum menerapkan nilai restore: kemungkinan `received_at` = awal transaksi vs floor `clock_timestamp()`, atau urutan reset/floor. Perbaiki akar masalah (jangan melemahkan test). Sentinel jalur lulus.
- A2 (architect P2): pull yang sedang berjalan menimpa sentinel `'rewind'` dengan cursornya (parseCatalogMark('rewind') null => isOlderCatalogCursor false, catalog-puller ~305-357). Jaga: bila nilai tersimpan `CATALOG_REWIND_MARK` dan pull ini bukan rewind, sentinel dipertahankan (halaman itu jangan menimpa). Runbook: hentikan API edge dulu atau tunggu pull selesai sebelum UPDATE.
- A3 (architect P3-low): cast `watermark::timestamptz` di `catalog-receipt-floor.ts` dan puller dibuat aman terhadap nilai rusak (regex ISO dulu; rusak = tidak ada floor). P3 floor-bersama: dibiarkan, cukup dicatat di runbook (keterbatasan).
- A4 (architect P1, protokol): cloud ekspor hanya `sync_txid < pg_snapshot_xmin`. Halaman akhir replay yang kosong/pendek bisa MENONAKTIFKAN item yang masih ada di cloud (tersembunyi sementara). Solusi: halaman cloud membawa dua field opsional baru `visibleBelow` (= pg_snapshot_xmin, string desimal) dan `horizon` (= pg_snapshot_xmax) dari snapshot yang sama dengan query halaman (packages/shared/src/edge/catalog-sync.ts pageOf, apps/api/src/services/edge-catalog-sync.ts ~1026; field opsional, edge lama mengabaikan, cloud lama tanpa field = edge TIDAK PERNAH menonaktifkan, marker bertahan). Logika edge: marker `catalog:replay:<stream>` watermark `"1"` saat rewind. Di halaman terakhir (hasMore=false) dengan marker: bila halaman tanpa field -> tidak berbuat apa-apa. Bila marker "1" -> ubah ke `h:<horizon>`. Bila marker `h:H` dan visibleBelow >= H -> deactivateAbsentCatalogRows lalu hapus marker; bila visibleBelow < H -> biarkan. Artinya penonaktifan terjadi di pull lengkap BERIKUTNYA sesudah semua baris yang ada saat replay selesai sudah terlihat. Tes T2 diubah mengikuti (dua pull; plus tes: transaksi terbuka di cloud menahan xmin => tidak ada penonaktifan).
- B (architect P2 uang): `promotions` yang hilang di cloud sesudah restore tetap aktif di edge dan memberi diskon offline. Nonaktifkan lewat kolom `status` (cek nilai nyata di crm-promo.ts dan cara edge menilai promo; pilih nilai yang membuat promo tidak berlaku, tetap tanpa DELETE). Vouchers tidak perlu. File: edge-catalog-restore-membership.ts.
