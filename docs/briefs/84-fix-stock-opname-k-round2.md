# Brief 84: fix review K putaran 2 — stok opname (ws/stock-opname, dari 3abd2cc3)

Peran: engineer. Worktree cabang `ws/stock-opname`. Kartu: legend-j5x. Sumber: reviewer Opus + architect (2026-11-08 21:55), keduanya PERLU FIX.

## Wajib dibetulkan
1. **Hitung buta bocor ke approver** (Tinggi) — `inventory-count.visibility.ts:52-66`, `inventory-count.service.ts:380-402,718-723`. Pemegang `inventory.opname.count` + `inventory.adjustment.approve` (mis. outlet manager) yang belum mengisi baris masih melihat saldo, lalu bisa mengisi lembar dengan angka sistem. Fix: selama `draft`/`counting` sembunyikan pasangan dari SEMUA orang (termasuk approver); detail/`systemQty` baru terbuka untuk approver bukan penghitung setelah submit. Siapa pun yang pernah membuka detail saat `pending_approval` dicatat (mis. `viewer_ids`) dan ditolak mengisi baris bila opname kembali ke `counting` (kode error baru di `packages/shared/src/inventory/errors.ts`).
2. **Nilai outflow salah** (Sedang) — `inventory-count.service.ts:1626`. Pengurangan dinilai biaya saat baris diisi, padahal outflow tidak mengubah avg (`schemas.ts:449`). Contoh: 10@1.000, terhitung 8, masuk 10@2.000, posting −2@1.000 → saldo 27.000 vs ledger 28.000. Fix: outflow pakai avg saat posting; simpan nilai yang benar-benar diposting per baris (kolom baru), dipakai laporan dan jurnal nanti. Inflow (stok temuan) tetap aturan S3.
3. **Migration** (Tinggi) — merge `main` ke cabang ini dulu, lalu ikuti aturan "Catatan merge milestone" di `docs/PROGRESS.md`:
   - ambil `apps/api/drizzle/**` dari main; buang 0063_stock_count, 0064_stock_count_rls, 0065_harsh_random, 0066_stock_count_deciders + snapshot + entri journal cabang;
   - `cd apps/api && pnpm db:generate` (tabel, `counter_ids`, `decider_ids`, kolom baru fix 1-2; cek partial unique index dan semua CHECK ikut);
   - `pnpm exec drizzle-kit generate --custom --name stock_count_rls`, salin 4 statement dari `apps/api/src/db/schema/inventory-count.custom.sql`;
   - `when` semua migration baru harus > 1794146407007 (edge 0069 di milestone/m1). Bila nomor bentrok dengan 0068/0069 milestone, merge `milestone/m1` (bukan main) dan generate di atasnya.

## Tidak dikerjakan di sini (sudah jadi kartu)
- Jurnal GL selisih opname (PRD J.4): jembatan inventori→GL belum ada untuk count, waste, HPP. Kartu terpisah, prasyarat rilis (lihat bd).
- Tebak stok lewat 409 waste/transfer: legend-0hzu, risiko diterima.

## Bukti selesai
- Test regresi untuk fix 1 (manager count+approve tidak lihat saldo saat counting; viewer saat pending_approval ditolak mengisi setelah reject) dan fix 2 (skenario 10@1.000/8/10@2.000 → saldo = total ledger).
- Migrate lulus di DB kosong dan DB yang sudah di milestone/m1 head; `src/db/outlet-rls.test.ts`, `src/test/inventory-count.test.ts`.
- Gate penuh: format, color, tenant-hardcode, `heavy pnpm check`, `heavy pnpm build`.
- Reviewer konteks segar atas diff fix. Commit lokal, jangan push.
- Laporan: SHA, test, daftar migration lama→baru dengan `when`.
