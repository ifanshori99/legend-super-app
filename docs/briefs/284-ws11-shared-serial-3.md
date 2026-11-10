# Brief lanjutan G88uh: WS-11 berkas bersama putaran 3 (F5 F8 F10 + legend-3nfc9)

Lanjutan di thread yang sama. Aturan sama dengan brief 260, 267, 272. Cabang baru `ws/ws11-shared-3` dari `ws/ws11-shared-2` (53c6b112 atau SHA sesudah bukti gagal-dulu putaran 2), worktree baru `.worktrees/ws11-shared-3`. Jangan push, jangan merge ke m1. Tanpa migrasi baru.

## 1. Satukan keluarga G45ej
Merge `--no-ff` berurutan: `ws/ws11-inventory-purchasing` (692e193c, F5), `ws/ws11-reservation-delivery` (f2f630d3, F8), `ws/ws11-facility` (191d5e75, F10). Ketiganya dibuat dari `487c928a`, jadi belum memakai kontrak putaran 2 (`writesTotal`, `share`, `weightCode`, `splitFrom`, `sourceTypes`, satu reader per kode+dimensi): sesuaikan reader mereka ke kontrak itu. `routeTree.gen.ts`: regenerasi. Berkas di luar standar keluarga yang ikut: F5 menghapus `ai-metrics/stock.ts` dan mengubah `ai-tools/read-a/tl-03-stock-levels.ts` + `metric-single-path.test.ts`; F10 `features/facility-report/mock.ts`.

## 2. Kartu berkas bersama
- `legend-3nfc9` butir (1)-(9) (baca kartu dan komentarnya): kait finalitas delivery di `metrics-daily.service.ts`; kode jumlah + hitung fasilitas lalu sumber `derived` (daftar `docs/briefs/268b-requests-facility.md`); `now` di `DailyComputeInput`; longgarkan test NON_GL lalu keluarkan `stock_value`, `purchase_total`, `supplier_due`, `delivery_sales` bila sumber GL ada; `SERVED_REPORTS` + `delivery` dengan `delivery.by_menu`/`delivery.settlement` mengikuti ketersediaan nyata; `ownerDashboardBoardRuns` fixture tidak memberi angka untuk metrik unavailable; mock `inventory-purchasing` lengkap 12 kode; tes drift mock-vs-registry untuk semua keluarga; replay ledger F5 memakai `posting_seq` hanya bila `ws/stock-ledger-sequence` sudah di m1, bila belum biarkan dan catat.
- `legend-fr62g`: `menu_sold_qty` tidak menghitung pesanan latihan.
- Mock `payments-tax`: `tax_payable` per outlet tampil "belum tersedia", sama dengan API.

## Bukti dan review
- Satu run gabungan: semua `ms-*.test.ts`, `metrics-engine`, `metrics-runtime`, `metric-sources-registry`, `metric-single-path`, `reports-run`, `dashboards-api`, `sales-targets`, `ws11-gl-parity`, test migrasi RLS; root ws11 + kontrak lewat `node --test`; sebut jumlah file dan tes.
- Test gagal-dulu untuk tiap butir kartu 2 (jalankan tes baru terhadap kode sebelum butir itu, sebut merah/hijau).
- `pnpm db:generate` kosong; typecheck shared/api/web lewat `heavy` sekali; eslint + prettier.
- Review tingkat K: satu `architect` untuk diff butir 2 dan penyesuaian kontrak keluarga.
- Perbarui satu brief Codex untuk seluruh area WS-11 (shared-1, shared-2, shared-3, semua keluarga): `docs/briefs/ws11b-second-opinion-ws11.md`, gabungkan brief Codex keluarga yang sudah ada; jangan dijalankan.

## Laporan
Sekali di akhir: SHA, konflik dan cara selesai, per butir (hasil, SHA), bukti, kontrak yang berubah, laporan yang kini berangka dan yang masih unavailable, langkah rilis (backfill), risiko, jumlah subagent dan puncak bersamaan.
