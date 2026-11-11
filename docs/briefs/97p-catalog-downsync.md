# 97p: catalog down-sync cloud -> edge (menu, harga, resep)

Kartu `legend-97p`. Stale check: PIN (`services/staff-pin-sync.ts`), device (`services/edge-device-sync.ts`), people/roles/employees (`services/edge-people-snapshot.ts`) SUDAH ada. KURANG: menu, harga, resep + kursor inkremental resumable + test koneksi putus.

## Pola wajib ditiru (jangan menciptakan ulang)
Tiru persis `services/edge-device-sync.ts` (keyset (updated_at,id), cursor opaque, settle window `DEVICE_SYNC_SETTLE_MS`, overlap, `isDeviceSyncCursorError`), `services/edge-device-sync-store.ts` (checkpoint di `edge_pull_checkpoints`, `db/schema/edge-node.ts:445`), `edge/device-registry-puller.ts`, `routes/edge-device-sync.routes.ts` (auth edge credential, strict Zod query, tenant+outlet dari credential, mount `/api/edge-sync/...`).

## Stream (semua tabel tenant-scoped, ada updated_at/deleted_at; soft-delete = tombstone, edge ikut menghapus)
menu_categories, menu_items, item_variants, modifier_groups, modifiers, menu_item_modifier_groups, price_lists, price_list_items, recipes, recipe_lines. (`db/schema/menu.ts`, `db/schema/recipe.ts`). Tabel tanpa updated_at: pakai kolom ordering yang ada, catat di laporan.

## Kontrak nama (supaya test-writer dan implementer sejalan)
- Shared Zod: `packages/shared/src/edge/catalog-sync.ts`: `catalogSyncQuerySchema` (strict: `stream` enum, `since` cursor opaque optional, `limit` 1..100), `catalogSyncPageSchema` (`stream`, `records[]`, `nextCursor`, `hasMore`), export dari package index seperti file edge lain.
- Cloud: `apps/api/src/services/edge-catalog-sync.ts`: `listCatalogRecordsSince(db, { tenantId, outletId, query })`; route `routes/edge-catalog-sync.routes.ts` -> `catalogRecordSyncRouter`, mount `/api/edge-sync/catalog` (cloud only).
- Edge: `applyCatalogRecords(tx, {tenantId, stream, records})` (idempotent upsert by id, cloud wins, tombstone ikut), `pullCatalog(...)` di `apps/api/src/edge/catalog-puller.ts` (loop per stream, checkpoint ditulis SETELAH page ter-apply dalam satu transaksi, resume dari checkpoint).
- Wiring ke periodic loop `edge/master-sync.ts` hanya bila kecil; kalau besar, lapor.

## Aturan uang dan akses (jangan sampai rugi)
- Harga (`price_list_items`, harga menu) disalin PERSIS apa adanya (integer minor unit), tanpa konversi/pembulatan di edge. Test: nilai harga edge == cloud, juga setelah resume dan setelah update ulang; harga lama tidak boleh menimpa harga baru (cursor mundur / page diulang / urutan terbalik).
- Edge tidak pernah menulis balik katalog ke cloud lewat jalur ini (read-only di cloud).
- Tenant dan outlet dari credential, bukan dari query. Cross-tenant dan cross-outlet test wajib: records tenant lain TIDAK pernah keluar; price_list outlet lain tidak keluar bila price list outlet-scoped.
- Edge credential dicabut/invalid: 401 sebelum membaca input.

## Test (vitest backend, `apps/api/src/test/edge-catalog-sync*.test.ts`, gagal-dulu)
1. Cloud export: paging keyset lengkap, tanpa duplikat/lompat saat updated_at sama; tombstone ikut; settle window.
2. Cursor rusak -> error cursor jelas (pola `isDeviceSyncCursorError`).
3. Apply idempotent (apply dua kali = state sama); cloud wins atas baris lokal berbeda.
4. Resume: putus setelah page ke-1 (fetch throw di page ke-2) -> checkpoint = page 1; pull ulang lanjut dari sana, hasil akhir == cloud, tidak ada baris ganda.
5. Putus di tengah apply (transaksi gagal) -> checkpoint tidak maju, tidak ada baris setengah.
6. Harga: lihat aturan uang. Isolasi tenant/outlet. Auth.

## Bukti selesai
`LEGEND_TEST_FILES="src/test/edge-catalog-sync.test.ts" heavy pnpm test` lulus; `NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck` 0; prettier --check berkas berubah; gagal-dulu tercatat. Migrasi hanya bila wajib (nomor sementara 0280); bila tidak perlu kolom baru, tidak ada migrasi.
