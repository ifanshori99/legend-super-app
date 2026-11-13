# Desain ws/purchasing-posting (kartu A-E), architect 13 Nov 2026, tingkat K (uang + migrasi)

Dasar: 7ec074441 + aefe28175. Desain induk: docs/briefs/ws-purchasing-apar-design.md (aturan tetap: toleransi default 0 maks 1000 bp, retur > sisa utang ditolak, baris jasa selalu held; founder Q13 permanen).
Test gagal-dulu yang SUDAH ada (untracked, jangan diubah assert-nya): apps/api/src/test/purchase-return-parked-debit-note.test.ts (C, PD-01..03), apps/api/src/test/accounting-asset-invoice-race.test.ts (D, AR-01..04).

## 0. Ringkas keputusan

| Kartu | Keputusan                                                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Jurnal penerimaan lewat konsumen auto-journal (bisa parkir). Faktur & retur bagian belum-ditagih hanya boleh bila jurnal penerimaan sudah terposting (penjaga cutover). Selisih harga ke akun baru `purchase_price_variance` (5105), bukan `inventory`. Flag tetap MATI di cabang ini. |
| B     | `createFixedAsset` dengan `sourceDocumentId` wajib blok `payable` (pemasok, nomor, tanggal, jatuh tempo) dan membuat open item AP = costIdr di tx yang sama.                                                                                                                           |
| C     | Pre-check retur: nota debit yang sudah settled ATAU diparkir non-retryable tidak dihitung; yang masih pending / parkir retryable tetap dicadangkan. Parkir "utang kurang" diberi kode sendiri dan dicek ulang harian.                                                                  |
| D     | Kunci advisory `payable-src:<tenant>:<id>` diambil di tx aset sebelum cek, dan di tx faktur sebelum insert/posting. Cek tenant-wide berjalan SETELAH kunci didapat.                                                                                                                    |
| E     | Tidak ada pemanggil AR nyata (tidak ada penjualan kredit / invoice pelanggan yang memanggil fungsi AR). Lewati, lapor di bead legend-smrwb.                                                                                                                                            |

## 1. Migrasi

- **0494 (custom SQL)** `apps/api/drizzle/0494_purchase_price_variance.sql`: pola persis 0205 (NO FORCE RLS sementara, idempoten, insert-only):
  - akun `5105` "Selisih Harga Pembelian", type `expense`, report_group `cogs`, parent 5100 bila ada dan bertipe sama, hanya untuk entitas yang sudah punya `account_mappings`;
  - mapping role `purchase_price_variance` ke 5105 bila belum ada mapping, akun aktif, tanpa anak.
  - Tag journal `0494_purchase_price_variance`, snapshot salin 0491 (tidak ada perubahan skema TS). `pnpm db:generate` harus kosong.
- **0495**: tidak dipakai (cadangan). D tidak butuh DDL (kunci advisory, bukan SECURITY DEFINER: fungsi definer yang menembus RLS outlet lebih berisiko daripada manfaatnya).
- Tidak ada perubahan migrasi lama. Tidak ada kolom baru.

## 2. Kartu A (legend-29vw): GRNI

### 2.1 Peta akun dan aturan posting (shared)

- `packages/shared/src/accounting/coa.ts`: tambah role `purchase_price_variance: "expense"` di `POSTING_ACCOUNT_ROLES`; baris CoA `["5105","Selisih Harga Pembelian","cogs","5100",["purchase_price_variance"]]`. VERIFIKASI `POSTING_ROLE_ALLOWED_TYPES` / daftar role wajib provisioning ikut.
- `packages/shared/src/i18n/messages/accounting-mapping.ts`: label "Selisih harga pembelian".
- `packages/shared/src/accounting/posting-rules.ts:393` rule `supplier_invoice.recorded`: ganti `["inventory","debit","priceVarianceIdr"]` jadi `["purchase_price_variance","debit","priceVarianceIdr"]` (negatif dibalik ke kredit oleh builder). Aman: posting faktur masih di belakang flag mati, belum ada jurnal produksi.
- `packages/shared/src/inventory/purchasing/errors.ts`: kode baru `GOODS_RECEIPT_NOT_JOURNALED` 409, pesan "Jurnal penerimaan barang belum terposting; faktur/retur belum bisa dibukukan."

### 2.2 Jurnal penerimaan (konsumen)

`apps/api/src/services/accounting-auto-journal-amounts.ts`:

- Tambah `"goods_receipt.recorded"` ke `AUTO_JOURNAL_EVENTS` (hapus komentar baris 341). `supplier_invoice.recorded` TETAP tidak masuk (test anti dobel menjaga).
- Schema stored: `{ goodsReceiptId, purchaseOrderId, supplierId, outletId, receivedValueIdr, receivedAt }`; `outletId` diambil dari envelope (`event.outletId`, payload GR tidak memuatnya) lalu disimpan di payload agar sweep bisa membangun ulang.
- Kunci: `aj:goods-receipt:<goodsReceiptId>`.
- Fact builder: baca ulang `goods_receipt_lines` (tenant + receipt, immutable) dan hitung `goodsReceiptValueIdr(lines, ROUNDING_MODE)`. Beda dengan payload -> `AutoJournalPayloadInvalid`. Nilai 0 -> `null` (ignored). Amounts `{ receivedValueIdr }`, ruleEvent `goods_receipt.recorded`, sourceId = receipt id, moneyTime = receivedAt (tanggal = business date outlet; periode tutup -> late adjustment pola yang ada).
- Gate: bila `purchasingPostingEnabled()` false -> `null` (ignored, tidak diparkir). Pakai file baru `apps/api/src/services/purchasing-posting-gate.ts` yang memegang flag env + seam test (pindahkan `postingEnabledOverride` dari purchasing-invoice.service.ts ke sini; `setSupplierInvoicePostingEnabled` tetap diekspor ulang dari invoice service agar test lama tidak berubah).
- Mapping `inventory`/`grni` hilang -> `AccountingError ACCOUNT_MAPPING_MISSING` -> konsumen yang ada memarkir retryable (sweep 10 menit). Tidak perlu kode baru di consumer.

### 2.3 Penjaga cutover (tidak ada Dr GRNI tanpa Cr GRNI)

- Faktur: di `postSupplierInvoicePayableInTransaction` (purchasing-invoice.service.ts ~632, satu titik untuk create/rematch/release), sebelum posting: setiap goods receipt PO itu yang bernilai > 0 (ada baris accepted > 0 dan unit cost > 0) wajib punya `journal_entries.idempotency_key = 'aj:goods-receipt:<id>'` (tenant). Ada yang belum -> lempar `PurchasingError GOODS_RECEIPT_NOT_JOURNALED` 409; tx rollback penuh (create matched tidak tersimpan; rematch/release tetap held). Faktur yang hasilnya held tetap boleh disimpan.
- Retur (dikerjakan implementer C, file sama): bila `uninvoicedValueIdr > 0` dan jurnal `aj:goods-receipt:<goodsReceiptId>` belum ada -> 409 `GOODS_RECEIPT_NOT_JOURNALED`, tidak menulis apa pun.
- Akibat: penerimaan sebelum flag nyala (atau saat modul akuntansi mati) tidak pernah bisa difaktur/diretur lewat sistem sampai finance membuat jurnal cutover (keputusan founder F2).

### 2.4 Selisih harga faktur vs GRNI (aturan eksplisit)

1. GRNI selalu dibersihkan pada harga PO: `goodsIdr = Σ extendCostIdr(qty faktur, harga PO baris)` per baris (sudah ada). Ini sama persis dengan yang dikredit penerimaan (`extendCostIdr(accepted, unitCostIdr=harga PO)`) untuk qty yang sama.
2. `priceVarianceIdr = barang harga faktur - goodsIdr` (bertanda) ke `purchase_price_variance` (5105, laba rugi). Persediaan GL tidak disentuh, jadi GL persediaan = nilai stock ledger tetap (INV-01); rata-rata bergerak tidak diubah.
3. Dalam toleransi (matched) dan rilis finance (held harga) sama-sama memakai aturan ini. Utang = total faktur - PPh 23 (yang ditagih pemasok), tidak pernah lebih.
4. Batas yang diketahui: PO line yang diterima di beberapa GR atau ditagih di beberapa faktur dengan qty/harga pecahan bisa menyisakan GRNI maks 1 rupiah per baris GR (pembulatan HALF_UP). Tidak memengaruhi pembayaran. Buat bead lanjutan "GRNI clearing remainder per PO line" (perlu simpan nilai GRNI per baris faktur dan per baris retur).

### 2.5 Idempotensi faktur (sudah ada, dijaga test)

Jurnal `si-post:<invoiceId>`, open item PK `(tenant,'payable',id)`, `supplier_invoices.id` PK, trigger status (matched/released beku), klaim idempotensi purchasing. Kirim ulang key sama = replay; rematch/release pada matched/released = 409 `SUPPLIER_INVOICE_NOT_HELD`.

### 2.6 Flag

`SUPPLIER_INVOICE_POSTING_ENABLED` default TETAP false di `apps/api/src/config/env.ts` (hanya perbarui komentar: menyalakan juga jurnal penerimaan). Nyala menunggu: semua test uang hijau, second-opinion Codex, jawaban founder F1-F2. Ragu = mati. `PURCHASE_RETURN_POSTING_ENABLED` juga tidak diubah.

### 2.7 Helper test

`apps/api/src/test/purchasing-ap-world.ts` (`seedReceivedPo`) dan `apps/api/src/test/purchasing-apar-helpers.ts`: setelah membuat GR, kirim event `goods_receipt.recorded` dari outbox lewat `deliverAutoJournalEvent` (bila flag+modul akuntansi nyala) supaya penjaga cutover lolos. Tanpa ini semua test faktur lama gagal 409.

## 3. Kartu B (legend-gzeya): aset kredit membuat open item AP

- `packages/shared/src/accounting/assets.ts` `createFixedAssetInputSchema`: tambah `payable: z.strictObject({ supplierId: uuid, documentNumber: string 1..60, documentDate: businessDate, dueOn: businessDate }).nullable().optional()`; superRefine: `sourceDocumentId !== null` wajib `payable` (422), `payable` tanpa `sourceDocumentId` 422, `dueOn >= documentDate`.
- `apps/api/src/services/accounting-fixed-assets.service.ts` `createFixedAsset`, di tx yang sama setelah jurnal `fa-acq:<id>`:
  - supplier dibaca di tx (tenant, id); tidak ada -> 422.
  - `recordSupplierInvoicePayableInTransaction(tx, ctx, { supplierInvoiceId: assetId, legalEntityId, outletId, supplierId, supplierName, invoiceNumber: documentNumber, invoiceDate: documentDate, dueOn, payableIdr: costIdr, journalEntryId: acqEntry.id, idempotencyKey: "fa-ap:"+assetId }, actorId)` TANPA dpp/ppn/pph23 -> hanya open item, tidak ada baris `supplier_invoices` (bukan catatan pajak).
  - Open item = kredit AP jurnal (costIdr) persis, jadi saldo GL AP = aging.
- Satu dokumen beberapa aset sah (open item per aset). Aset dengan `sourceDocumentId` = id faktur pemasok / open item payable yang ada tetap 409 (lihat D).
- Fixture/test lama yang memakai `sourceDocumentId` non-null harus diberi `payable`: `packages/shared/src/accounting/fixtures.ts`, `apps/api/src/test/accounting-ledger-guard-test-helpers.ts`, dan test `accounting-fixed-asset-*.test.ts`, `accounting-ap-fa.test.ts`, `purchasing-apar-hardening.test.ts`, `accounting-asset-no-double-ap.test.ts` (hanya input, bukan assert). Web: `apps/web/src/features/ws07-ap-assets/components/asset-form-dialog.tsx` + `mock.ts` (field pemasok/nomor/jatuh tempo bila sumber diisi).

## 4. Kartu C (legend-3fi5v): nota debit diparkir

`apps/api/src/services/purchase-return.service.ts` `splitReturnAgainstInvoices` (baris ~567-625), ganti `priorDebit - bookedDebit`:

- Per retur terdahulu PO itu dengan `invoiced + ppn > 0`, status:
  - **settled**: ada settlement `method='debit_note'` dengan `source_id = returnId` -> tidak dihitung (sudah di dalam `settledIdr`).
  - **gagal**: ada `auto_journal_parked` (tenant, `idempotency_key = 'aj:purchase-return:'||id`, `retryable = false`) -> tidak dihitung (tidak mengurangi apa pun).
  - **pending / parkir retryable** (belum dikonsumsi, mapping hilang, periode tutup): DIHITUNG sebagai cadangan, karena akan terposting sendiri nanti.
- `owed = Σ(original - settled open item faktur PO) - Σ cadangan`. Retur > owed -> 409 tetap.
- Alasan menyimpang dari teks kartu "hitung hanya yang settled": bila pending tidak dicadangkan, dua retur cepat lolos, yang kedua diparkir, dan pemasok dibayar penuh atas barang yang sudah diretur (bayar lebih). Ini aturan yang membatasi pembayaran (F5).
- Penjaga cutover retur (2.3) di file ini juga.
  `apps/api/src/services/accounting-auto-journal-consumer.ts` (alur perbaikan):
- Kelas error baru `AutoJournalDebitNoteShort` kode `AUTO_JOURNAL_DEBIT_NOTE_SHORT` menggantikan `AutoJournalPayloadInvalid` di catch `PURCHASE_RETURN_EXCEEDS_PAYABLE` (baris ~524); tambah ke `parkCodeOf`. Non-retryable (PD-01 mengharapkan `retryable:false`), tapi seperti `DEAD_LETTERED_CODE`: `next_retry_at = now + 24 jam` dan `retryParkedAutoJournals` memasukkannya di filter `or(...)`.
- Recheck harian mengalokasi ke open item payable pemasok yang sama di legal entity yang sama (faktur baru pemasok menyerap kredit retur). Tidak muat -> parkir lagi. Tidak pernah setengah: jurnal retur + settlement dalam satu savepoint; kunci `aj:purchase-return:<id>` + unique index debit_note mencegah dobel.
- Redelivery manual (test PD-02) tetap jalan lewat jalur yang sama.

## 5. Kartu D (legend-ct27s): cek aset vs faktur dengan kunci

- File baru `apps/api/src/services/payable-source-lock.ts`:
  `export async function lockPayableSource(tx: Tx, tenantId: TenantId, sourceId: string): Promise<void>` = `SELECT pg_advisory_xact_lock(hashtextextended('payable-src:' || tenantId || ':' || sourceId, 0))`.
- `createFixedAsset`: di tx utama, sebelum cek: `lockPayableSource(tx, tenantId, sourceDocumentId)`. Lalu cek tenant-wide (pola R3, tidak terhalang RLS outlet) dijalankan SETELAH kunci didapat dan juga memeriksa `accounting_open_items` kind payable dengan id itu. Karena kunci dipegang sampai commit, faktur yang sedang dibuat dengan id itu sudah commit sebelum cek membaca -> 409.
- `purchasing-invoice.service.ts` (dikerjakan implementer A): `lockPayableSource(tx, tenantId, invoiceId)` tepat setelah id faktur dibuat (create) dan setelah `findInvoice(..., lock)` (rematch/release), sebelum insert/posting.
- Urutan kunci: faktur = PO FOR UPDATE lalu payable-src; aset = payable-src saja. Tidak ada siklus.

## 6. Kartu E (legend-smrwb)

Tidak ada pemanggil AR nyata. Tidak dikerjakan. Engineer menulis catatan di bead dan PROGRESS.

## 7. Pembagian file (4 implementer, tidak bertumpuk)

- **I-A (GRNI + variance + cutover faktur + kunci sisi faktur)**: `packages/shared/src/accounting/{coa.ts,posting-rules.ts}`, `packages/shared/src/i18n/messages/accounting-mapping.ts`, `packages/shared/src/inventory/purchasing/errors.ts`, `apps/api/src/services/accounting-auto-journal-amounts.ts`, `apps/api/src/services/purchasing-invoice.service.ts`, baru `apps/api/src/services/purchasing-posting-gate.ts`, `apps/api/src/config/env.ts` (komentar), `apps/api/drizzle/0494_purchase_price_variance.sql` + `meta/_journal.json` + `meta/0494_snapshot.json`, helper `apps/api/src/test/purchasing-ap-world.ts`, `apps/api/src/test/purchasing-apar-helpers.ts`. Kerjakan errors.ts dulu (C butuh kodenya).
- **I-C (retur + konsumen)**: `apps/api/src/services/purchase-return.service.ts`, `apps/api/src/services/accounting-auto-journal-consumer.ts`.
- **I-BD (aset)**: `packages/shared/src/accounting/{assets.ts,fixtures.ts}`, `apps/api/src/services/accounting-fixed-assets.service.ts`, baru `apps/api/src/services/payable-source-lock.ts` (buat paling awal; signature di atas), fixture test aset yang disebut di 3, web `apps/web/src/features/ws07-ap-assets/{components/asset-form-dialog.tsx,mock.ts}`.
- **I-T (test-writer)**: file test baru di 8. Tidak menyentuh service.
- Tidak ada yang menyentuh `accounting-ap.service.ts` / `accounting-open-items.service.ts`.

## 8. Test uang (gagal-dulu)

Baru:

- `apps/api/src/test/purchasing-grni-journal.test.ts`: GR-01 event GR -> jurnal Dr persediaan / Cr GRNI = nilai baris GR, redelivery tidak dobel; GR-02 mapping `grni` dihapus -> parked `ACCOUNT_MAPPING_MISSING` retryable, nol jurnal; mapping kembali -> sweep posting sekali; GR-03 saldo GRNI nol setelah GR + faktur matched (qty sama), dan setelah GR + faktur sebagian + retur sisa; GR-04 faktur atas GR tanpa jurnal -> 409 `GOODS_RECEIPT_NOT_JOURNALED`, nol baris di purchase_invoices/lines/supplier_invoices/open items/journal/outbox/idempotensi; GR-05 rilis faktur selisih harga +5% -> baris `purchase_price_variance`, GRNI nol, jurnal seimbang, utang = total - PPh 23; GR-06 kirim ulang key sama / rematch matched / release dua kali -> satu jurnal `si-post`, satu open item; GR-07 flag mati -> event GR ignored; GR-08 tenant B: event tenant A ignored, faktur A 404; GR-09 saldo GL AP = total aging, utang <= total faktur; GR-10 retur bagian belum-ditagih atas GR tanpa jurnal -> 409.
- `apps/api/src/test/purchase-price-variance-migration.test.ts`: 0494 idempoten, hanya entitas ter-provision, akun custom 5105 dipertahankan.
- `apps/api/src/test/accounting-asset-credit-payable.test.ts`: open item = costIdr dan GL AP = aging; replay idempoten tanpa open item kedua; `sourceDocumentId` tanpa `payable` 422; pemasok tenant lain 422; sumber = id faktur -> 409 tanpa jurnal/open item; aset kredit + faktur PO yang sama tidak membuat utang dua kali; pembayaran open item aset tidak melebihi cost.
  Tambahan di `purchase-return-parked-debit-note.test.ts` (test-writer, bukan implementer): PD-04 dua retur cepat belum dikonsumsi, jumlah > owed -> yang kedua 409; PD-05 parkir retryable (mapping hilang) tetap dicadangkan; PD-06 parkir `DEBIT_NOTE_SHORT`, faktur baru pemasok sama, sweep harian posting sekali, utang tidak di bawah nol.
  Sudah ada, wajib hijau: `accounting-asset-invoice-race.test.ts` (AR-01..04), `purchase-return-parked-debit-note.test.ts` (PD-01..03), `accounting-asset-no-double-ap.test.ts`, `accounting-purchase-return-journal.test.ts`, `purchase-return-ap-open-item.test.ts`, `purchase-return-invoiced-split.test.ts`, `purchasing-invoice.test.ts`, `purchasing-apar-hardening.test.ts`, `purchasing-policy.test.ts`, `inventory-receiving.test.ts`. Assert yang memeriksa baris varians di akun `inventory` (bila ada) diperbarui test-writer ke `purchase_price_variance`.

## 9. Keputusan founder (lewat CTO; usul = membatasi pembayaran)

- **F1** Selisih harga faktur vs PO masuk 5105 "Selisih Harga Pembelian" (laba rugi), bukan persediaan. Usul: ya (GL persediaan = stok). Konfirmasi akuntan.
- **F2** Penerimaan sebelum go-live jurnal: faktur/retur ditolak 409 sampai finance membuat jurnal cutover. Usul: tolak.
- **F3** Aset kredit: utang = costIdr, PPN masukan aset belum didukung. Usul: terima untuk sekarang, bead lanjutan.
- **F4** Flag `SUPPLIER_INVOICE_POSTING_ENABLED` tetap mati sampai test uang hijau, second-opinion, dan F1-F2 dijawab.
- **F5** Nota debit pending / parkir retryable tetap mengurangi ruang retur berikut (menyimpang dari "hanya settled"). Usul: ya.

## 10. Risiko

- Konsumen GR async: faktur langsung setelah GR bisa 409 sampai worker memproses (detik). Pesan jelas, coba lagi.
- Sisa GRNI pembulatan maks 1 rupiah per baris GR (2.4.4), bead lanjutan.
- Retur yang diparkir `DEBIT_NOTE_SHORT`: jurnal retur juga belum terposting (GL persediaan lebih tinggi dari stok) sampai recheck berhasil. Sudah begitu sebelum cabang ini; sekarang dicek ulang harian.
- Parkir dicek per outlet (RLS `auto_journal_parked` outlet): retur dan PO satu outlet, aman.

# Review K ws/purchasing-posting (architect, 13 Nov 2026). Line numbers = scratchpad/ff-backup versions.

Verdict: no blocker for the commit while both flags stay OFF. H1 must be fixed before merge; H2 and M1 before the flag goes on.

## H1 Supplier can be paid twice: asset payable has no link to the purchase (new in this branch)

- accounting-fixed-assets.service.ts:1177 (assertSourceIsNotSupplierInvoice), :1275-1330 (open item `fa-ap:<id>`).
- Failure: the duplicate check matches only on id (supplier_invoices / payable open item / purchase_invoices). A PO id, GR id or random uuid as `sourceDocumentId` passes. Case 1: the asset is bought via PO -> GR -> supplier invoice and also registered as an asset with sourceDocumentId = PO id. Case 2: the same request is sent twice with a new idempotency key. Either way there are 2 payable open items for one purchase, and the payment run pays both. Before this branch the asset had no open item, so only the GL was wrong and the payment was not.
- Fix: (a) inside the locked check, refuse 409 when sourceDocumentId is a `purchase_orders.id` or `goods_receipts.id` of the tenant. (b) Lock `payable-doc:<tenant>:<supplierId>:<upper(trim(documentNumber))>` and refuse 409 when a supplier_invoices row (supplier_id, invoice_number) or a payable open item (counterparty_id, document_number) already exists, unless an explicit "one document, several assets" flag says so. Test: asset with source = PO id -> 409; a second asset with the same supplier+number -> 409.

## H2 Return of invoiced goods leaves the price variance on the payable (pre-existing; this branch locks it into 5105)

- purchase-return.service.ts:459: `invoicedValueIdr` is valued at receipt cost (PO price), but the PPN share is valued at the billed price.
- Failure: PO price 100, invoice price 105 x10 (released). Full return: debit note = 1000 + full PPN, so 50 stays owed and the supplier is paid for returned goods. 5105 keeps +50. A negative variance gives the reverse: the debit note is larger than the bill.
- Fix before SUPPLIER_INVOICE/PURCHASE_RETURN flags go on: value the invoiced part at billed value (slot.billedIdr, same slots as the PPN). Book the difference as `["purchase_price_variance","credit","returnPriceVarianceIdr"]` in the purchase_return.recorded rule (signed). Test: GR-05 + full return -> AP 0, 5105 0, GRNI 0.

## M1 Cutover has no repair path (F2 cannot be done)

- purchasing-invoice.service.ts:633-689 and purchase-return.service.ts:958 accept only `journal_entries.idempotency_key = 'aj:goods-receipt:<id>'`. A manual cutover journal by finance never has that key. Receipts made while the flag was off (event ignored, accounting-auto-journal-amounts.ts:1319) or parked PAYLOAD_INVALID stay unbillable and unreturnable for good.
- Fix: add a platform/finance command "journal receipt <id>" that re-delivers the outbox event through deliverAutoJournalEvent (flag on). The guard also accepts a cutover marker (table or source_type/source_id = GR id). Add a bead and a test.

## M2 Migration order: gap 0492/0493

- drizzle/meta/_journal.json: idx 494 when=1794653692431, previous 0491. The drizzle pg migrator runs only migrations with `when` > the last applied created_at. If another branch's 0492/0493 merges later with a smaller `when`, it is skipped silently on DBs that already ran 0494.
- Fix: before merge, check main for 0492/0493. Renumber with scripts/migration-renumber.mjs so `when` rises in merge order (or confirm the custom migrator does not use the timestamp).

## Checked, OK

- 0494: idempotent (NOT EXISTS + ON CONFLICT DO NOTHING), insert only, NO FORCE/FORCE RLS as 0205. Only entities that have mappings. No role CHECK on account_mappings. Snapshot = 0491 body, prevId chain correct. Low: an existing custom 5105 (active expense leaf) gets mapped even when it means something else. Consider mapping only when name = 'Selisih Harga Pembelian', or log it.
- GRNI balanced: GR unitCostIdr = orderLine.unitPriceIdr (inventory-receiving.service.ts:712). Emit and consumer both use goodsReceiptValueIdr. The invoice clears at PO price, and the uninvoiced part of a return debits GRNI at receipt cost. Late adjustment keeps the same `aj:goods-receipt` key. Rounding remainder <= 1 rupiah per line is a known follow-up bead.
- Double journal: GR key aj:goods-receipt:<id> is unique; supplier_invoice.recorded is still not in AUTO_JOURNAL_EVENTS; si-post + open item PK unchanged.
- C: pending and retryable-parked returns stay reserved (limits payment). Excluding retryable=false is safe because applySupplierDebitNoteInTransaction locks the supplier open items FOR UPDATE and refuses above outstanding, so the payable never goes below 0. Low: rows parked PAYLOAD_INVALID from EXCEEDS_PAYABLE before this branch are not moved to the daily recheck. Fix with a one-off UPDATE in 0495 or a note, if the return flag was ever on.
- D: lock order invoice = PO FOR UPDATE -> invoice row -> advisory; asset = advisory -> read on a 2nd connection (READ COMMITTED, after the lock). No cycle. Info: the lock on create (purchasing-invoice.service.ts:1144) uses a new randomUUID, so it is defence only. Held invoices are already caught by the purchase_invoices read.
- Tenant: every new query filters tenantId. Supplier lookup on the asset is tenant-scoped (422). The GR fact reads under the event outlet scope.
- Low (verify): finance release of an invoice held for quantity (qty > received) debits GRNI beyond the credit, so GRNI goes to a debit balance. Confirm release allows only a price hold, or refuse when invoice qty > accepted - returned.
