# 97p: putaran perbaikan setelah review architect

Tambahan atas `97p-catalog-downsync.md`. Keputusan teknis (CTO tidak perlu memutuskan):

## Sisi cloud (`services/edge-catalog-sync.ts`, `packages/shared/src/edge/catalog-sync.ts`)
1. Filter brand: `menu_categories`, `menu_items`, `recipes` hanya brand outlet pemanggil (`outlets.brand_id` dari credential). `item_variants`, `menu_item_modifier_groups`, dan baris anak lain ikut lewat join ke induknya. `modifier_groups`/`modifiers`: periksa apakah punya brand; bila ya filter sama. Test: tenant 2 brand, outlet brand A tidak pernah menerima brand B (kategori, item, resep).
2. Resep: record `recipes` membawa SEMUA baris lengkap: `lines: RecipeLineRecord[]` (ganti `lineIds`). Stream `recipe_lines` dihapus dari `CATALOG_SYNC_STREAMS`.
3. Daftar harga: record `price_lists` membawa semua itemnya: `items: PriceListItemRecord[]` (hanya item yang aktif/tidak terhapus; harga integer persis). Stream `price_list_items` dihapus. Setiap perubahan item sudah menaikkan `updated_at` daftar (`menu-pricing.service.ts:712`); verifikasi, dan bila ada jalur ubah item tanpa menaikkan updated_at, lapor.
4. Urutan stream tetap induk dulu: categories, modifier_groups, modifiers, menu_items, item_variants, menu_item_modifier_groups, price_lists, recipes.

## Sisi edge (`services/edge-catalog-apply.ts`, `edge/catalog-puller.ts`)
5. Apply `recipes`: upsert header + ganti seluruh baris (hapus yang tidak ada di `lines`, upsert sisanya) dalam satu transaksi, guard `updated_at <=` tetap. Apply `price_lists`: upsert header + ganti seluruh item (hapus yang tidak ada di `items`) satu transaksi, guard sama, harga persis. Header tidak pernah ada tanpa itemnya.
6. Referensi hilang di edge:
   - `recipes.updated_by` (user belum ada di edge; people snapshot membawanya nanti): TRANSIEN. Record itu ditolak dengan kode `CATALOG_MISSING_REF`, checkpoint stream tidak maju, stream lain jalan terus.
   - `recipes.output_item_id` (edge tidak punya `inventory_items`, nullable): jadi null bila item tidak ada lokal (permanen, dicatat di hasil: `nulledRefs`), checkpoint maju. `station_id` sama (stations tidak disinkronkan).
   - `parent_id` kategori yang induknya belum ada: ditulis null sementara; puller mencatat pasangan (id, parentId) dalam memori dan setelah stream kategori selesai membaca semua page, menjalankan pass perbaikan (set parent bila induk kini ada) dalam satu transaksi. Satu pull = satu pass.
7. Isolasi per stream: `pullCatalog` menangkap error tiap stream, melanjutkan stream berikut, dan hasil akhir memuat `streams[stream].error`. Putus koneksi tetap menghentikan stream itu tanpa memajukan checkpoint.
8. Kunci: `pg_advisory_xact_lock` (pola `master-sync`) per (tenant, stream) di dalam transaksi apply, supaya dua pull bersamaan tidak mengadu timestamp ms yang sama.

## Test (`apps/api/src/test/edge-catalog-sync.test.ts`)
Tambah/ubah: multi-brand, resep atomik (versi baru memuat semua baris, baris hilang terhapus, tidak pernah dua versi campur), daftar harga selalu dengan itemnya (header tanpa item tidak mungkin), updated_by hilang -> checkpoint tidak maju + stream lain jalan, output_item_id null permanen, parent_id repair pass, isolasi error per stream, dua pull bersamaan tidak membuat harga lama menang. Hapus/ubah test yang memakai `lineIds`, `recipe_lines`, `price_list_items` sebagai stream.
