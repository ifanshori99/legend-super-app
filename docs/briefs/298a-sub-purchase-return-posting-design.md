# 298a: desain jurnal retur pembelian dan pembelian sederhana (WS-07, tingkat K uang)

Keputusan architect (10 Nov 2026). Worktree: `.worktrees/purchase-return-posting`. Kartu `legend-1xbs`, `legend-v3lh`.
Jangan menjurnal `goods_receipt.recorded` (di luar scope, kartu `legend-29vw`). Jangan ubah `inventory-gl-consumer.ts` logikanya.

## Potongan A: packages/shared (satu implementer)
1. `packages/shared/src/inventory/purchasing/events.ts`: `purchaseReturnRecordedEventPayloadSchema` ditambah `outletId` (outletIdSchema yang dipakai goods_receipt), `uninvoicedValueIdr`, `invoicedValueIdr`, `ppnIdr` (semua idr integer >= 0). `valueIdr` tetap. Refine: `valueIdr === uninvoicedValueIdr + invoicedValueIdr`; `ppnIdr > 0` hanya bila `invoicedValueIdr > 0`.
2. Event baru `petty_purchase.recorded`: payload id-only strict `{ pettyPurchaseId, outletId, amountIdr (>0), businessDate, paidBy, paidAt }` (pakai id schema `pettyPurchaseIdSchema` di schemas.ts). Daftarkan di `purchasingEventPayloadSchemas`, tambah ke `packages/shared/src/events/catalog.ts` baris WS-06 (setelah `purchase_return.recorded`). Cek test kontrak yang menghitung katalog.
3. `coa.ts`: role baru `petty_purchase_expense` (tipe expense), akun baru `5104 Pembelian Langsung (Kas Kecil)` di bawah 5100, mapping role ke 5104. `petty_cash` (1102) sudah ada.
4. `journal.ts`: source type baru `purchase_return` dan `petty_purchase`.
5. `posting-rules.ts` (ikuti pola `rule()` goods_receipt/supplier_invoice, `AUTO` dan teks INV/PRD):
   - `purchase_return.recorded`, sourceType `purchase_return`: Dr `grni` `uninvoicedValueIdr`; Dr `accounts_payable` `debitNoteIdr`; Cr `inventory` `valueIdr`; Cr `ppn_input` `ppnIdr`. `debitNoteIdr = invoicedValueIdr + ppnIdr` dihitung di fact builder.
   - `petty_purchase.recorded`, sourceType `petty_purchase`: Dr `petty_purchase_expense` `amountIdr`; Cr `petty_cash` `amountIdr`.
   Baris jumlah 0 tidak boleh membuat baris jurnal (cek perilaku `buildJournalLinesFromRule`).

## Potongan B: apps/api (satu implementer)
1. `apps/api/src/db/schema/accounting.ts` baris ~302: tambah `'purchase_return'`, `'petty_purchase'` ke `journal_entries_source_type_check`.
2. Migrasi tunggal `0205_purchase_return_posting.sql`, entri `_journal.json`: idx 205, `when` 1794284000000, tag `0205_purchase_return_posting`. Isi: ubah check constraint (drop + add), backfill akun 5104 dan mapping `petty_purchase_expense` untuk entitas yang sudah punya `account_mappings`, idempoten, meniru `0147_accounting_coa_backfill_1204.sql` (NO FORCE RLS lalu pulihkan). Cek apakah ada `drizzle/meta/0205_snapshot.json` yang perlu (lihat pola 0186); `pnpm db:generate` harus kosong.
3. `apps/api/src/services/accounting-auto-journal-amounts.ts`: tambah `purchase_return.recorded` dan `petty_purchase.recorded` ke `AUTO_JOURNAL_EVENTS` (bukan goods_receipt). Kasus di `storedEventOf` (cek outlet envelope dengan `assertEnvelopeOutlet`), `autoJournalKeyOf` (`aj:purchase-return:<id>`, `aj:petty-purchase:<id>`), `autoJournalFactOf` (amounts: `uninvoicedValueIdr`, `debitNoteIdr`, `valueIdr`, `ppnIdr`; petty: `amountIdr`). `valueIdr` 0 atau `amountIdr` 0: tidak ada fact (status ignored). Pastikan consumer pohon `accounting-auto-journal-consumer.ts` tidak perlu diubah; bila perlu, ubah minimal.
4. Worker: pastikan event baru sampai ke consumer (cek `worker-main.ts` / daftar langganan event).

## Potongan C: test-writer (gagal dulu)
Test di `apps/api/src/test/accounting-purchase-return-journal.test.ts` (ikuti pola `accounting-payroll-journal.test.ts` / test auto-journal terdekat) dan test kontrak shared (pola `tests/purchasing-contract.test.mjs`):
- retur sebelum ditagih (uninvoiced saja): Dr GRNI, Cr persediaan, seimbang.
- retur sesudah ditagih: Dr utang usaha (`invoicedValueIdr`), Dr/Cr PPN masukan bila `ppnIdr`; seimbang.
- retur campuran: split seimbang.
- pembelian sederhana: Dr beban pembelian langsung (5104), Cr kas kecil; seimbang.
- event sama dua kali: satu jurnal (`already_posted`).
- isolasi tenant: event tenant lain `ignored`.
- modul akuntansi mati: `ignored`.
- valueIdr 0: `ignored`.
- `stock.moved` dari `purchase_return` tetap diabaikan bridge inventory.
- payload refine: jumlah tidak cocok ditolak; `ppnIdr>0` tanpa invoiced ditolak.
- Pesanan latihan: tidak berlaku (event ini bukan order), catat di komentar.
Jangan mengubah `e2e/acceptance`.

## Bukti
`bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`; typecheck api dan shared lewat `heavy` satu kali oleh agen utama. Subagent tidak menjalankan tsc/test penuh; hanya test berkas sendiri dengan `LEGEND_TEST_FILES`.
