# 662 contract: daftar pengecualian finance (legend-4oclu)

Worktree `.worktrees/fin-exc-662`, cabang `ws/finance-exceptions`, migrasi 0546-0549.

## Endpoint
`GET /api/accounting/finance-exceptions?kind=&outletId=&from=&to=` (from/to = tanggal bisnis YYYY-MM-DD, wajib dua-duanya, maks 92 hari).
- File baru: `routes/accounting-finance-exceptions.routes.ts` (daftarkan di `routes/index.ts`), `services/accounting-finance-exceptions.service.ts`, `packages/shared/src/validators/finance-exceptions.ts` + subpath `exports`, DTO di `packages/shared/src/types/api.ts`.
- Guard: `requireAuth, requireTrustedOrigin, requireTenantContext` lalu `requireMenuPermission("accounting.journal.view")` (pola `accounting-cash-deposits.routes.ts`). Scope outlet lewat `getScopedTenantContext(req)`; outlet di luar scope tidak terlihat. Tanpa izin: 403.
- Respons: `{ summary: [{kind, count, amountIdr}], items: [{kind, outletId, occurredAt (ISO), refType, refId, amountIdr: number|null, detail: string|null}], truncated: boolean }`. Items maks 500, urut occurredAt desc. `summary` dihitung penuh (bukan dari items yang terpotong). Tanpa data: array kosong.

## Jenis (kind) dan sumber
1. `edge_tax_unsnapshotted`: order edge (`edge_order_ingests.state='ingested'`) dengan `orders` pajak > 0 yang TIDAK punya baris `tax_snapshots` (source_type 'order', source_id = order). Keanggotaan dihitung dari join itu (benar untuk data lama). Nilai = pajak order. `detail` = `tax_missing`/`tax_mismatch` dari kolom baru `edge_order_ingests.tax_flag` (migrasi 0546, text nullable, check in ('tax_missing','tax_mismatch')), diisi di `edge/order-ingest.ts` ~L368-386 saat `taxesUsable` false; null untuk baris lama.
2. `edge_void_unsupported`: baris `auto_journal_parked` dengan `error_code='AUTO_JOURNAL_VOID_UNSUPPORTED'`. Nilai = total order dari `payload.orderId` (null bila order tidak ditemukan). Tanggal = `last_failed_at`.
   `edge_void_refused` (legend-nbkvh, 1042 F2): `edge_order_ingests` dengan `state='ingested'` dan `reason='void_refused:manual_refund_exists'` (void edge ditolak karena order sudah di-refund manual; laci kas outlet bisa kurang). Nilai = total order, `detail` = `manual_refund_exists`, refType `order`. Tanggal = `updated_at` (zona waktu outlet).
3. `edge_receipt_skipped`: `edge_receipt_skips` (tanpa rupiah; amountIdr = total order bila `order_id` ada, selain itu null). Tanggal = `created_at`.
4. `edge_link_dead_letter`: `edge_link_dead_letters` (amountIdr null). Tanggal = `created_at`.
5. `payout_fee_not_posted`: `payroll_payout_gl_postings` dengan `fee_posted=false`. Nilai fee dari `total_encrypted` memakai helper dekripsi yang sudah dipakai `repostSkippedFees`; gagal dekripsi: null, jangan melempar. `detail` = id batch. Hanya tenant itu; outlet scope: bila tabel tak punya outlet, hanya tampil untuk pemanggil tanpa batas outlet (tenant-wide).

Tiap baris sumber muncul tepat sekali. Filter `kind` menyaring; outletId menyaring (jenis tanpa outlet dikecualikan bila outletId diisi).

## Aturan
- Read-only. Tanpa mutasi. Tanpa PII; jangan kembalikan payload mentah.
- Semua query difilter `tenant_id` dari sesi.
- Uang: tidak ada mutasi, jadi bukti test = penghitungan nilai benar dan tidak bocor lintas tenant/outlet.
