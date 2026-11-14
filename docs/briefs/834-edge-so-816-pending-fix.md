# Lanjutan 818: satu P1 dari review architect atas fix/edge-so-816 (037d7614e)

Worktree lamamu sudah dihapus. Buat worktree baru dari `origin/fix/edge-so-816`, cabang yang sama, lalu push tanpa force.

## Temuan (P1, ketersediaan)
`apps/api/src/edge/master-sync.ts:748` `syncEdgeMasters` memanggil `markEdgeMasterSnapshotPending(config)` sebelum halaman pertama diterapkan; hanya `recordAppliedMasterSnapshotVersion` (:761) yang membersihkan `pending`. Bila sinkron master gagal berulang (LOCAL_CONFLICT, MASTER_PAGES_EXCEEDED, atau jaringan putus di antara halaman), `pullCatalogRounds` (:864-865) melempar MASTERS_INCOMPLETE untuk semua stream katalog; setelah `CATALOG_SALES_BLOCK_AFTER_MS` gerbang katalog (`catalog-gate.ts`) memblok penjualan. Regresi dari kontrak "gagal satu tidak menghentikan yang lain" (komentar :780).

## Keputusan CTO
Gagal sinkron: turunkan kemampuan, jangan blok. `try/catch` di loop :741-760, saat gagal `masterCapabilities.set(config, { version: null, pending: false })` lalu lempar ulang. Katalog lalu tarik dengan CATALOG_PROTOCOL_MIN_VERSION (resep brand outlet sendiri saja); sukses v2 berikut melebarkan lagi lewat rewind resep yang sudah ada.

## Bukti
- Test gagal-dulu: halaman 1 sukses, halaman 2 gagal, tarik katalog berikut tetap jalan dengan protokol 2 dan penjualan tidak terblok. Plus kasus LOCAL_CONFLICT berulang.
- Test edge master/katalog yang ada tetap hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), typecheck API sekali lewat heavy, prettier/eslint.
- Laporan: sha baru, test, angka subagent.
