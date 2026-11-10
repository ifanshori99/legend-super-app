# Second opinion (Codex): inventory small fixes

Repo: /Users/ifanshori99/Projects/legend super app/legend, cabang `ws/inventory-small-fixes` (worktree `.worktrees/inventory-small-fixes`). Basis 4c818489. Diff: `git diff 4c818489..HEAD`. Read-only; jangan ubah kode.

## Perubahan (tingkat K)
1. legend-r2zv (1f987a70): payload `stock.critical.quantity` jadi nullable; null bila pasangan (lokasi, item) ada di hitung buta terbuka (`hiddenBlindPairs`). Cek: jalur bocor lain di `inventory-par-alerts.service.ts`, consumer payload yang rusak saat null, event yang sudah terkirim sebelum hitung dibuka.
2. legend-1ozj (671d3fa3): kode izin baru `inventory.item.manage` (grant warehouse), tulis master item digerbang kode itu, baca katalog item/UOM lewat `requireMenuPermission` + `assertCatalogRead`. Cek: pelebaran lingkup outlet, kebocoran antar tenant, peran yang kehilangan akses tulis item, jalur fail-open.
3. legend-0jfi: tidak ada perubahan (sudah ada di m1, commit 59e96f16). Konfirmasi bahwa list/detail stock-count tidak membawa systemQty/varianceIdr ke non-approver saat hitung buta.
4. legend-tk7i: ditahan (butuh migrasi).

## Format laporan
Hanya cacat nyata: file:line, skenario gagal konkret, usulan perbaikan. Maks 20 baris.

## Tambahan 26c3de28..92d81f70 (migrasi 0172 backfill inventory.item.manage + FK production_orders.recipe_id, fallback dihapus, setup write ke item.manage, waste mediaId)
