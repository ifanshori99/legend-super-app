# Desain bersama: 24318 + d0ipm + 456 (katalog edge, sync_txid)

Cabang `ws/24318-catalog-puller-loop` (dasar 6343a727). Semua jalur ini uang (harga) + akses: jangan sampai harga lama menang atau harga hilang. Subagent memakai berkas ini; baca bagian milikmu saja.

## Kartu
- legend-24318: sambung `pullCatalog` (apps/api/src/edge/catalog-puller.ts) ke loop master-sync edge (`startEdgeMasterSyncLoop`, edge/master-sync.ts:498; dimulai edge/runtime.ts:939); tambah stream `stations` dan `inventory_items`; checkpoint resep jangan macet bila `updated_by` belum ada di edge.
- legend-d0ipm: `deleteItem` (services/menu.service.ts:1354) ikut soft-delete `price_list_items` item itu dan menaikkan `price_lists.updated_at` (sentuh baris price_lists agar trigger sync_txid menyala). Modifier per brand: modifier_groups/modifiers tidak punya brand_id, ubah model TIDAK dilakukan; catat saja di laporan (butuh keputusan founder).
- legend-0mus6 (brief 456): 3 P1 + 2 P2 dari Codex.

## Desain sync_txid (keputusan CTO, menggantikan kursor waktu + settle window + overlap)
- Tiap tabel stream punya kolom `sync_txid bigint NOT NULL`. Isi: trigger BEFORE INSERT OR UPDATE `NEW.sync_txid := pg_current_xact_id()::text::bigint` (xid8 dibuang ke bigint lewat text). Default kolom juga `pg_current_xact_id()::text::bigint` (backfill: semua baris lama dapat txid migrasi).
- Tabel: menu_categories, modifier_groups, modifiers, menu_items, item_variants, menu_item_modifier_groups, price_lists, recipes, + baru: stations, inventory_items. Index `(sync_txid, id)` per tabel (join table: `(sync_txid, menu_item_id, group_id)`).
- Trigger tidak boleh menimpa nilai di edge: edge menulis `sync_txid` dari cloud. Trigger melewati bila `current_setting('legend.skip_sync_txid', true) = 'on'`; apply edge menjalankan `select set_config('legend.skip_sync_txid','on',true)` (lokal ke transaksi) sebelum menulis.
- Server (cloud) hanya mengirim baris dengan `sync_txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint` (batas "aman-commit": tidak ada transaksi lebih tua yang masih bisa commit), urut `(sync_txid, id)` (join table: `(sync_txid, menu_item_id, group_id)`), keyset `(sync_txid, keys) > since`. Hapus `CATALOG_SYNC_SETTLE_MS`, `CATALOG_SYNC_OVERLAP_MS`, `rewindCatalogCursor`, dan overlap di puller.
- Cursor: tag baru `cat2`, `[ "cat2", "<sync_txid digits>", ...keys ]`. Cursor `cat1` atau rusak: server menolak (isCatalogSyncCursorError); puller memperlakukan checkpoint `cat1` sebagai tidak ada (tarik ulang dari awal, aman karena apply idempoten).
- Record sinkron membawa `syncTxid: string` (digit, `/^\d+$/`) di tiap stream. Record price_lists dan recipes: `syncTxid` milik induk (anak ikut dokumen induk).
- Apply edge: baris lokal hanya diganti bila `incoming.syncTxid > stored.sync_txid` (sama = lewati juga boleh, idempoten; lebih kecil = tolak/lewati, tidak pernah menimpa). Tidak lagi membandingkan `updated_at`. Dua pull paralel yang kembali berurutan terbalik tidak boleh menimpa data baru dengan data lama (temuan 2).
- Anak recipes/price_lists diganti seluruhnya bersama induk, di transaksi yang sama (seperti sekarang).

## Temuan 3 (kunci unik daftar harga)
`price_lists` punya unique hidup (outlet, channel, effective_from) di cloud. Apply edge: (a) dalam satu halaman, terapkan semua tombstone (`deletedAt != null`) lebih dulu, baru upsert hidup; (b) lintas halaman/seri sama-txid: sebelum insert/upsert baris hidup, soft-delete baris lokal hidup lain (id berbeda) yang bentrok kunci unik (cloud menang). Berlaku juga untuk unique hidup lain di stream (stations (tenant,outlet,name), dll.) bila ada. Test: A dihapus + B dibuat kunci sama, B di halaman terpisah/lebih dulu; hasil: harga B aktif, A tidak.

## Temuan 4 (repair parent kategori)
`catalog-puller.ts` ~:224 memperbaiki parent kategori hanya di memori. Buat durable (simpan di checkpoint/tabel yang ada) atau rekonstruksi dari state DB setelah restart (misal: parent yang belum ada dihitung ulang tiap pull dari baris lokal). Test: restart (instance puller baru) tidak kehilangan perbaikan.

## Temuan 5
Backlog > 100.000 baris: otomatis selesai karena cursor sync_txid maju; hapus `maxPages` yang mengulang halaman sama atau pastikan checkpoint disimpan per halaman dan loop lanjut dari checkpoint terakhir.

## 24318: resep dan updated_by
Apply menolak halaman bila `updated_by` belum ada di tabel `user` edge (edge-catalog-apply.ts:644-655) -> checkpoint macet selamanya bila penulis resep (user HQ) tidak ada di people snapshot outlet. Keputusan: `recipes.updated_by` jadi NULLABLE (migrasi; kode cloud tetap selalu mengisi), apply edge menaruh null bila user tidak ada lokal dan menghitung di `nulledRefs` (pola sama `output_item_id`). Tandai di laporan sebagai keputusan skema untuk CTO.

## Stream baru (urutan di CATALOG_SYNC_STREAMS = urutan pull)
Urutan akhir: `stations`, `inventory_items`, `menu_categories`, `modifier_groups`, `modifiers`, `menu_items`, `item_variants`, `menu_item_modifier_groups`, `price_lists`, `recipes`.
- `stations` (db/schema/menu.ts:107): kolom id, tenantId, outletId, name, type (enum 5 nilai STATION_TYPES), printerDeviceId (uuid nullable, polos), targetSeconds, stamps (createdAt, updatedAt, deletedAt). Scope outlet kredensial. Tombstone via deletedAt.
- `inventory_items` (db/schema/inventory.ts:79): tenant-wide, TANPA deleted_at (tidak aktif = `isActive=false`). Kolom: id, tenantId, name, category, type, baseUomId, isPerishable, isActive, parMin, parMax, createdAt, updatedAt (lihat skema untuk tipe persis; angka NUMERIC dikirim string desimal persis). `idempotency_key` TIDAK dikirim. FK `(tenant_id, base_uom_id)` ke `uoms`: uoms tiba lewat syncEdgeMasters; bila uom belum ada lokal: tolak halaman (transient, checkpoint tetap), bukan null (kolom wajib). Karena itu loop menjalankan `syncEdgeMasters` dulu, lalu `pullCatalog`.
- Setelah stations/inventory_items tersedia: apply tetap menolak/null `station_id`/`output_item_id` hanya bila baris itu memang tidak ada lokal.

## Wiring (24318)
Loop master-sync tiap tick: `syncEdgeMasters` lalu `pullCatalog` (kegagalan katalog tidak menggagalkan master dan sebaliknya; tiap error masuk `onError`). `fetchPage(stream, since)` memakai klien HTTP cloud edge yang sudah ada (EdgeCloudHttpError, edge/runtime.ts config). Catatan: people puller jalan lebih dulu dan tiba sebelum loop. Boot: tick awal tidak ada; bila mudah, jalankan satu tick katalog setelah bootstrap, tapi jangan memblokir boot.

## Pembagian berkas (tidak bertumpuk)
- A (schema + migrasi + kontrak): `apps/api/src/db/schema/*` (kolom `syncTxid` lewat helper baru `apps/api/src/db/schema/sync-txid.ts` mengekspor `syncTxidColumn()`), `apps/api/drizzle/*` (migrasi nomor sementara `0284_catalog_sync_txid`: ganti nama sql, snapshot, tag journal; idx tetap berurutan; `pnpm --filter @starter/api db:generate` harus kosong sesudahnya; trigger fungsi + trigger ditulis tangan di SQL), `packages/shared/src/edge/catalog-sync.ts`.
- B (server): `apps/api/src/services/edge-catalog-sync.ts`, `apps/api/src/services/menu.service.ts` (d0ipm), `apps/api/src/routes/edge-catalog-sync.routes.ts`.
- C (edge): `apps/api/src/services/edge-catalog-apply.ts`, `apps/api/src/edge/catalog-puller.ts`, `apps/api/src/edge/master-sync.ts`, `apps/api/src/edge/runtime.ts`.
- Tests: `apps/api/src/test/edge-catalog-sync.test.ts` (perbarui kontrak lama), berkas baru `edge-catalog-txid.test.ts`, `edge-catalog-loop.test.ts`, `menu-delete-item-price-list.test.ts` (test-writer).

## Bukti
Test gagal-dulu per temuan (dua transaksi bersamaan untuk 1+2; txid lama tidak menimpa; A-dihapus+B-dibuat; restart puller; backlog > halaman; resep updated_by tak dikenal tidak macet; stations/inventory_items tiba; loop memanggil puller; deleteItem menyentuh price_list_items), lint paket, typecheck API (`NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck`), `LEGEND_TEST_FILES="..." heavy pnpm test`. Hanya SATU subagent menjalankan tsc/vitest pada satu waktu (token heavy dipegang test-writer sampai test gagal-dulu tercatat; sesudahnya engineer/test-runner).
