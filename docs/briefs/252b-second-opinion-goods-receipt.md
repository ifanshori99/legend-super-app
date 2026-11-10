# Brief: second-opinion — goods receipt parsial + QC + foto (legend-o1o4s)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/goods-receipt-partial-qc`, cabang `ws/goods-receipt-partial-qc`, SHA `9541fd34`.
Rentang diff: `git diff d8ea5e0b 9541fd34` (basis milestone/m1 `d8ea5e0b`; abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `apps/api/src/services/inventory-receiving.service.ts`
- `apps/api/src/routes/inventory-receiving.routes.ts`
- `apps/api/src/db/schema/inventory-receiving.ts`
- `apps/api/src/db/schema/purchasing.ts` (hanya CHECK kind sequence: `PO`, `GR`)
- `apps/api/drizzle/0173_goods_receipts.sql`

## Invariant (PRD)
- INV-05: goods receipt sebagian menambah stok hanya sebesar qty diterima lolos QC (diterima dikurangi ditolak), lewat ledger stok append-only.
- Akumulasi qty diterima lolos QC per baris PO tidak boleh melebihi qty dipesan, termasuk saat dua penerimaan berjalan bersamaan.
- Posting ulang idempoten: retry dengan idempotency key yang sama, atau posting ulang stok, tidak menggandakan baris ledger.
- Konversi satuan beli ke satuan dasar dan biaya per satuan dasar tepat (bigint, tanpa float).
- Status PO `sent` ke `partially_received` ke `received` hanya lewat mesin status kontrak.
- Foto hanya objek `core_storage_objects` milik tenant dan outlet yang sama.
- Isolasi tenant dan outlet dipaksa di setiap query dan setiap tabel baru (RLS + FORCE). Dokumen penerimaan immutable untuk `legend_app`.

## Effort
xhigh (stok dan uang, migrasi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
