# Desain ws/purchasing-apar: kartu A, B, C, D (architect, 13 Nov 2026, tingkat K)

Brief induk: `docs/briefs/ws-purchasing-apar.md`. Bagian bertanda **VERIFIKASI** belum dicek di kode; implementer wajib cek dulu.

## 0. Yang sudah ada (jangan dibuat ulang)

- Kontrak WS-06 lengkap: `packages/shared/src/inventory/purchasing/schemas.ts` (`supplierInvoiceSchema`, `supplierInvoiceLineSchema`, `threeWayMatch()` baris 1216, `supplierInvoiceDetailSchema`), `endpoints.ts` (`listSupplierInvoices`, `getSupplierInvoice`, `createSupplierInvoice`, `postSupplierInvoiceMatch`, input `createSupplierInvoiceInputSchema`, `recordSupplierInvoiceMatchInputSchema`), `events.ts` (`supplier_invoice.recorded`, `supplier_invoice.matched`), `errors.ts` (`SUPPLIER_INVOICE_NOT_MATCHED` dst.).
- Tabel `supplier_invoices` (`apps/api/src/db/schema/purchasing.ts:114`) = catatan pajak AP, append-only (REVOKE UPDATE/DELETE di `purchasing.custom.sql`), ditulis HANYA oleh `recordSupplierInvoicePayableInTransaction` (`accounting-ap.service.ts:77`) bersama open item (id sama). Laporan pajak membaca tabel ini. Jadi faktur yang ditahan TIDAK boleh masuk tabel ini.
- Posting rule `supplier_invoice.recorded` (`packages/shared/src/accounting/posting-rules.ts:395`): Dr grni goodsIdr, Dr inventory priceVarianceIdr (negatif = sisi lain), Dr service_expense, Dr ppn_input / Cr pph23_payable, Cr accounts_payable payableIdr. Event ini TIDAK ada di `AUTO_JOURNAL_EVENTS` (`accounting-auto-journal-amounts.ts:142`), jadi jurnal harus diposting di tx purchasing lewat `postJournalFromRuleInTransaction` (`accounting-journal.service.ts:558`).
- Test gagal-dulu kartu D sudah ada: `apps/api/src/test/purchase-return-ap-open-item.test.ts` (PRA-01..08), debit note masuk lewat `deliverAutoJournalEvent` untuk `purchase_return.recorded`, kartu dan buku besar bergerak di tx yang sama.
- Belum ada: tabel dokumen faktur sisi purchasing, baris faktur, setting toleransi, service, dan route faktur.

## 1. Tabel (migrasi 0490 generate, 0491 custom)

Nomor 0490/0491 sementara; merge train menomori ulang (`scripts/migration-renumber.mjs`). Cara menulis idx 490 di journal: **VERIFIKASI** dengan engineer (pola cabang lain, mis. 0417/0418 di batch54). Setelah selesai `pnpm db:generate` harus kosong.

### 0490 (drizzle generate) di `apps/api/src/db/schema/purchasing.ts`

`purchase_invoices` (T + outlet): dokumen faktur pemasok WS-06. `id` = id `supplier_invoices` = id open item AP bila AP diposting.
- `tenant_id`, `outlet_id` NOT NULL, `id uuid PK` (server `randomUUID`), `legal_entity_id` NOT NULL (dari outlet), `supplier_id`, `purchase_order_id`
- `number varchar(60)`, `invoice_date`, `due_date` (businessDate)
- `goods_idr` (harga PO), `price_variance_idr` (bertanda), `services_idr`, `ppn_idr`, `pph23_idr`, `total_idr`, `payable_idr` (idrColumn)
- `tolerance_bp integer` (snapshot kebijakan saat match), `match_result varchar(12)` `matched|discrepancy`, `match_snapshot jsonb` (hasil `ThreeWayMatch`), `match_note varchar(500)`
- `status varchar(12)` `matched|held|released|rejected`
- `recorded_by text`, `recorded_at`, `decided_by text NULL`, `decided_at NULL`, `decision_note varchar(500) NULL`, `journal_entry_id uuid NULL`, `updated_at`
- FK komposit: (tenant, outlet, purchase_order_id) ke `purchase_orders`, (tenant, supplier_id), (tenant, legal_entity_id), (tenant, journal_entry_id).
- CHECK: total = goods + variance + services + ppn; payable = total - pph23; payable > 0; due_date >= invoice_date; tolerance_bp 0..1000; `status IN (...)`; `(status IN ('matched','released')) = (journal_entry_id IS NOT NULL)`; `(status IN ('released','rejected')) = (decided_by IS NOT NULL)`; `status <> 'matched' OR match_result = 'matched'`; `status NOT IN ('held','released') OR match_result = 'discrepancy'`; `decided_by IS NULL OR decided_by <> recorded_by` (pisah tugas di DB).
- UNIQUE partial `(tenant_id, supplier_id, lower(btrim(number))) WHERE status <> 'rejected'` (faktur dobel = jalur bayar dobel).
- Index `(tenant_id, purchase_order_id, status)`.

`purchase_invoice_lines` (T + outlet, append-only): `tenant_id`, `outlet_id`, `id`, `purchase_invoice_id`, `line_no`, `purchase_order_line_id NULL`, `kind goods|service`, `description varchar(200)`, `quantity decimal4 >0`, `unit_price_idr decimal4 >=0`, `line_total_idr >=0`. FK (tenant, outlet, invoice), (tenant, po_line). UNIQUE (tenant, invoice, line_no). CHECK `kind='service' OR purchase_order_line_id IS NOT NULL`. Index (tenant_id, purchase_order_line_id).

`purchasing_policies` (T): `tenant_id PK`, `three_way_match_tolerance_bp integer NOT NULL` CHECK 0..1000, `updated_by text`, `created_at`, `updated_at`. Tanpa baris = default (lihat keputusan K1).

Di `apps/api/src/db/schema/accounting-ap-fa.ts`:
- `accounting_open_item_settlements.method` CHECK jadi `IN ('payment','write_off','debit_note')`, tipe `$type` ikut.
- UNIQUE partial index `accounting_open_item_settlements_debit_note_key` pada `(tenant_id, kind, open_item_id, source_id) WHERE method = 'debit_note'` (idempotensi debit note di DB). CHECK `method <> 'debit_note' OR source_id IS NOT NULL`.

### 0491 (custom) di `apps/api/src/db/schema/purchasing.custom.sql`

- `app.enforce_tenant_rls` + `app.enforce_outlet_rls` untuk `purchase_invoices`, `purchase_invoice_lines`; tenant saja untuk `purchasing_policies`.
- `REVOKE UPDATE, DELETE, TRUNCATE ON purchase_invoice_lines FROM legend_app`.
- `REVOKE UPDATE, DELETE, TRUNCATE ON purchase_invoices FROM legend_app; GRANT UPDATE (status, decided_by, decided_at, decision_note, journal_entry_id, match_result, match_snapshot, match_note, tolerance_bp, updated_at) ON purchase_invoices TO legend_app`.
- FK ke tabel outlet FORCE RLS: tulis inline di CREATE TABLE (pola 1 contracts.md), **VERIFIKASI** di test migrasi.

## 2. Aturan match, toleransi, hold

Satu fungsi murni (`threeWayMatch`, shared) dipakai saat create, re-match, dan release.

1. **Qty per baris**: kumulatif ditagih (semua faktur lain di PO yang status <> rejected, termasuk held, ditambah baris ini) tidak boleh melebihi **net diterima** = (received - rejected) - qty diretur. Toleransi qty = 0. Tambah parameter `returnedLines?: {purchaseOrderLineId, quantity}[]` (satuan PO; konversi dari base qty retur pakai rasio baris GR `(received - rejected) / accepted_base_quantity`, dibulatkan ke bawah untuk net diterima).
2. **Harga per baris**: dibandingkan dengan harga PO secara eksak tanpa pembulatan: `|harga faktur - harga PO| * 10000 > toleranceBp * harga PO` maka `price_outside_tolerance`. Ganti cek `Math.abs(priceVarianceBp) > tol` (bp yang dibulatkan bisa meloloskan 200,4 bp pada toleransi 200). `priceVarianceBp` tetap dikirim untuk tampilan.
3. Header goods/services harus sama dengan jumlah baris (sudah ada).
4. **Baris jasa** (tidak ada di PO, tidak ada penerimaan) selalu membuat faktur `held` (alasan `service_lines_need_review` di `match_note`). Lihat K3.
5. **PPN** > 12% DPP (dibulatkan setengah ke atas) ditolak 422; `pph23Idr > 0` tanpa baris jasa ditolak 422; `pph23Idr <= servicesIdr`.
6. Status:
   - semua bersih dan tanpa baris jasa: `matched`, AP diposting di tx yang sama.
   - ada isu: `held`, TANPA jurnal dan TANPA open item (tidak bisa dibayar sama sekali karena `paySupplierInvoiceInTransaction` butuh open item).
   - `held` ke `matched` lewat `POST /:id/match` (re-match ulang dengan data terkini; bila bersih, AP diposting).
   - `held` ke `released` lewat release finance (AP diposting dengan jumlah faktur).
   - `held` ke `rejected` (terminal, tanpa AP; nomor boleh dipakai lagi).
   - `matched`/`released` tidak bisa di-reject (butuh pembalikan AP, di luar lingkup): 409.
7. **Siapa boleh rilis hold** (membatasi pembayaran): izin `accounting.supplier_payment.process` (hanya finance dan owner; peran purchasing tidak punya), `actor <> recorded_by` (403, juga CHECK DB), catatan wajib min 10 karakter, outlet dalam jangkauan. Release menjalankan ulang match; hanya boleh bila isu yang tersisa hanya `price_outside_tolerance` dan/atau baris jasa. `quantity_exceeds_receipt`, `no_purchase_order_line`, `line_total_mismatch`, `invoice_total_mismatch` tidak bisa dirilis (409 `SUPPLIER_INVOICE_RELEASE_BLOCKED`): pemasok harus kirim faktur koreksi.
8. Semua create/match/release/reject mengunci baris PO `FOR UPDATE` dulu (kunci yang sama dengan penerimaan dan retur), jadi cap kumulatif tidak bisa balapan.

## 3. Toleransi per tenant (kartu B)

- Tabel `purchasing_policies` (bukan `finance_policies`: PUT-nya penggantian penuh dan dipakai layar kas-bank; menambah field memecah klien).
- `GET /api/inventory/purchasing-policy`: izin `purchasing.invoice.match` atau `accounting.supplier_payment.process`.
- `PUT /api/inventory/purchasing-policy`: izin `accounting.supplier_payment.process` (melonggarkan toleransi menaikkan risiko bayar lebih, jadi hanya finance/owner). Body `{ threeWayMatchToleranceBp: 0..1000, expectedUpdatedAt: iso|null, idempotencyKey }`, stale berarti 412 PRECONDITION_FAILED (pola `inventory-settings.service.ts`), diaudit before/after.
- Faktur menyimpan `tolerance_bp` yang dipakai; perubahan kebijakan tidak mengubah faktur lama, tapi re-match/release memakai kebijakan saat itu.

## 4. Service dan signature

File baru `apps/api/src/services/purchasing-invoice.service.ts`:

```ts
export async function createSupplierInvoice(context: ScopedTenantContext, actorUserId: string, input: z.infer<typeof createSupplierInvoiceInputSchema>, now?: Date): Promise<SupplierInvoiceDetail>
export async function rematchSupplierInvoice(context: ScopedTenantContext, actorUserId: string, supplierInvoiceId: string, input: z.infer<typeof recordSupplierInvoiceMatchInputSchema>, now?: Date): Promise<SupplierInvoiceDetail>
export async function releaseSupplierInvoice(context: ScopedTenantContext, actorUserId: string, supplierInvoiceId: string, input: z.infer<typeof decideSupplierInvoiceInputSchema>, now?: Date): Promise<SupplierInvoiceDetail>
export async function rejectSupplierInvoice(context: ScopedTenantContext, actorUserId: string, supplierInvoiceId: string, input: z.infer<typeof decideSupplierInvoiceInputSchema>, now?: Date): Promise<SupplierInvoiceDetail>
export async function listSupplierInvoices(context: ScopedTenantContext, actorUserId: string, query: z.infer<typeof supplierInvoiceQuerySchema>): Promise<CursorPage<SupplierInvoice>>
export async function getSupplierInvoice(context: ScopedTenantContext, actorUserId: string, supplierInvoiceId: string): Promise<SupplierInvoiceDetail>
// internal, tidak diekspor ke route:
async function postSupplierInvoicePayableInTransaction(tx: TenantTransaction, context: ScopedTenantContext, invoice: PurchaseInvoiceRow, supplierName: string, actorId: UserId, now: Date): Promise<string /* journalEntryId */>
export const SUPPLIER_INVOICE_READ_PERMISSIONS: readonly PermissionCode[]
export function setSupplierInvoicePostingEnabled(enabled: boolean | null): void // test seam, lihat K5
```

File baru `apps/api/src/services/purchasing-policy.service.ts`:

```ts
export async function getPurchasingPolicy(context: ScopedTenantContext): Promise<PurchasingPolicy>
export async function putPurchasingPolicy(context: ScopedTenantContext, actorUserId: string, input: unknown, now?: Date): Promise<PurchasingPolicy>
export async function loadMatchToleranceBpInTransaction(tx: TenantTransaction, tenantId: string): Promise<number>
```

Tambahan di `accounting-ap.service.ts`:

```ts
export async function applySupplierDebitNoteInTransaction(
  tx: TenantTransaction, context: ScopedTenantContext,
  input: { purchaseReturnId: string; supplierId: string; legalEntityId: string; purchaseOrderId: string | null;
           amountIdr: number; settledOn: BusinessDate; journalEntryId: string },
  actorId: UserId | null,
): Promise<{ settlements: SettlementResult[] }>
```

Di `accounting-open-items.service.ts`: `settleOpenItemInputSchema.method` tambah `"debit_note"` (wajib `sourceId`), audit seperti write-off (`accounting.payable.debit_noted`).

Pola idempotensi dan izin: `claimPurchasingIdempotency` / `completePurchasingIdempotency` dan `requireOpsPermission` seperti `purchase-return.service.ts:327`.

## 5. AP di transaksi yang sama (kartu A + C)

Dalam satu `withTenant(db, context, tx => ...)`:

1. Cek izin outlet, klaim idempotensi.
2. Kunci PO `FOR UPDATE`. PO harus milik outlet dan tenant yang sama (bila tidak, 404), status approved/sent/partially_received/received, supplier faktur = supplier PO (422).
3. Baca baris PO, baris GR, baris retur, baris faktur lain (status <> rejected), toleransi. Hitung match dan jumlah header di server (klien hanya kirim baris, PPN, PPh 23).
4. Insert `purchase_invoices` + lines.
5. Bila `matched`: `postJournalFromRuleInTransaction(tx, ctx, { eventName: "supplier_invoice.recorded", amounts: { goodsIdr, priceVarianceIdr, servicesIdr, ppnIdr, pph23Idr, payableIdr }, legalEntityId, outletId, entryDate: invoiceDate, sourceId: invoiceId, postedBy, idempotencyKey: "si-post:" + invoiceId })`, lalu `recordSupplierInvoicePayableInTransaction(tx, ctx, { supplierInvoiceId: invoiceId, legalEntityId, outletId, supplierId, supplierName, invoiceNumber, invoiceDate, dueOn: dueDate, payableIdr, dppIdr: goods + variance + services, ppnIdr, pph23Idr, journalEntryId, idempotencyKey: "si-ap:" + invoiceId }, actor)`, lalu set `journal_entry_id`.
6. Outbox `supplier_invoice.matched` (selalu) dan `supplier_invoice.recorded` (hanya bila AP diposting).
7. Lengkapi idempotensi.

Error apa pun (mapping akun hilang, periode tutup, NPWP kosong untuk PPh 23, konflik nomor) dilempar dan seluruh tx rollback: tidak ada header, baris, jurnal, open item, outbox, atau klaim idempotensi yang tersisa.

**Anti dobel buku:**
- Jangan pernah menambahkan `supplier_invoice.recorded` ke `AUTO_JOURNAL_EVENTS`. Jurnalnya sudah diposting di tx. Test menjaga ini.
- Baris faktur hanya `goods` (wajib baris PO, item persediaan) atau `service`. Tidak ada jenis aset. Faktur tidak pernah memposting `asset_acquisition`.
- `createFixedAsset` (`accounting-fixed-assets.service.ts:1157`): bila `sourceDocumentId` = id `purchase_invoices` atau `supplier_invoices` milik tenant, tolak 409 sebelum posting (AP sudah dibukukan faktur). Aset dari pembelian hanya lewat `sourceDocumentId` dokumen non-faktur.
- Satu dokumen satu open item: PK `(tenant, kind, id)` dan PK `supplier_invoices.id` menolak release atau re-match ganda.
- Bagian AR: tidak ada pemanggil nyata. Tidak dikerjakan; catat di laporan kartu `legend-uyk2`.

## 6. Debit note retur ke open item AP (kartu D)

**Emitter** (`purchase-return.service.ts`, di tx retur yang sudah mengunci PO): pecah tiap baris retur dengan aturan **belum-ditagih-dulu** per baris PO (dalam base unit):
- `belumDitagih = net diterima - qty ditagih pada faktur AP (status matched/released) - retur sebelumnya yang belum ditagih` (minimum 0).
- `uninvoicedValue` = nilai baris x min(retur, belumDitagih) / retur (HALF_UP).
- `invoicedValue` = sisanya.
- `ppnIdr` = jumlah per faktur dari `invoice.ppn x invoicedValue / DPP faktur` (HALF_UP), kumulatif tidak melebihi PPN faktur.
- Faktur held tidak dihitung "ditagih": tidak ada AP yang bisa didebit. Re-match/release-nya nanti memakai net diterima setelah retur, jadi tertahan.
- Pra-cek: `invoicedValue + ppn` tidak boleh melebihi sisa utang faktur AP pemasok untuk PO itu (409 `PURCHASE_RETURN_EXCEEDS_PAYABLE`, lihat K2).
- Kolom `purchase_returns.invoiced_value_idr` / `ppn_idr` sudah ada. Gate `PURCHASE_RETURN_POSTING_ENABLED` tetap.

**Konsumen** (`deliverAutoJournalEvent`, kasus `purchase_return.recorded`, sesuai test PRA-01..08): setelah jurnal retur diposting di tx konsumen, bila `debitNoteIdr = invoicedValueIdr + ppnIdr > 0` panggil `applySupplierDebitNoteInTransaction` di tx yang sama.
- Alokasi: open item `payable` pemasok itu di legal entity yang sama, utamakan faktur PO retur, lalu `due_on`, `document_date`, `id` naik.
- Tiap potongan = settlement `method='debit_note'`, `source_id = purchaseReturnId`, `journal_entry_id` = jurnal retur, `settled_on = max(tanggal retur, document_date)`, idempotency key `ap-dn:<returnId>:<openItemId>`.
- Kurang sisa utang saat konsumsi (balapan dengan pembayaran): lempar `AutoJournalPayloadInvalid` (diparkir, tidak ada yang tercatat setengah).
- Ulang/redelivery: kunci jurnal `aj:purchase-return:<id>` + UNIQUE partial index + idempotency key, jadi tidak mengurangi lagi.
- **VERIFIKASI**: di file mana konsumen menangani replay (apakah keluar sebelum posting saat jurnal sudah ada; bila ya, debit note juga tidak jalan ulang) dan apakah `supplierId`/`purchaseOrderId` ada di payload yang di-parse konsumen. `purchaseReturnRecordedSchema` di `accounting-auto-journal-amounts.ts:341` belum memuat `supplierId`, jadi tambahkan atau baca dari baris `purchase_returns`.

## 7. Route dan izin (izin yang sudah ada saja)

Router baru `apps/api/src/routes/purchasing-invoice.routes.ts`, mount `/api/inventory` di `routes/index.ts`. Pola seperti `purchase-return.routes.ts`: `requireAuth`, `requireTrustedOrigin`, `requireTenantContext`, `jsonBody` di POST/PUT, `requireOutletPermission` (outlet dari body/query), service mengecek ulang outlet dokumen. RLS menyembunyikan tenant/outlet lain (404).

| Metode | Path | Izin |
|---|---|---|
| GET | `/supplier-invoices`, `/supplier-invoices/:id` | `purchasing.invoice.match` atau `accounting.supplier_payment.process` |
| POST | `/supplier-invoices` | `purchasing.invoice.match` |
| POST | `/supplier-invoices/:id/match` | `purchasing.invoice.match` |
| POST | `/supplier-invoices/:id/release` | `accounting.supplier_payment.process` + bukan perekam |
| POST | `/supplier-invoices/:id/reject` | `purchasing.invoice.match` atau `accounting.supplier_payment.process` |
| GET | `/purchasing-policy` | `purchasing.invoice.match` atau `accounting.supplier_payment.process` |
| PUT | `/purchasing-policy` | `accounting.supplier_payment.process` |

## 8. Validator dan kontrak shared

Di `packages/shared/src/inventory/purchasing/`:
- `schemas.ts`: `supplierInvoiceStatusSchema = z.enum(["matched","held","released","rejected"])`; field `status` di `supplierInvoiceSchema` (`matchStatus` tetap: matched/released jadi `matched`, held/rejected jadi `discrepancy`); `threeWayMatch` + `returnedLines` + cek toleransi eksak; `purchasingPolicySchema`.
- `endpoints.ts`: `decideSupplierInvoiceInputSchema = clientInputSchema({ note: z.string().trim().min(10).max(500), idempotencyKey })`; `putPurchasingPolicyInputSchema`; endpoint `releaseSupplierInvoice`, `rejectSupplierInvoice`, `getPurchasingPolicy`, `putPurchasingPolicy`, masukkan ke `purchasingEndpoints`.
- `errors.ts`: `SUPPLIER_INVOICE_DUPLICATE` 409, `SUPPLIER_INVOICE_NOT_HELD` 409, `SUPPLIER_INVOICE_RELEASE_BLOCKED` 409, `SUPPLIER_INVOICE_SELF_RELEASE` 403, `PURCHASE_RETURN_EXCEEDS_PAYABLE` 409 (+ pesan Indonesia).
- `fixtures.ts` dan mock web `apps/web/src/features/ws06-purchasing/receiving-mock.ts`: tambah `status`, ganti `MATCH_TOLERANCE_BP` dengan kebijakan.
- Kontrak payables: enum metode settlement bila ada (**VERIFIKASI** `packages/shared/src/accounting/payables.ts`).

## 9. Test wajib (gagal dulu)

Aturan uang 1, lebih dari PO/penerimaan berarti ditahan (`apps/api/src/test/purchasing-invoice.test.ts`):
- qty melebihi net diterima: held, tanpa jurnal, open item, atau `supplier_invoices`; pembayaran gagal.
- harga +201 bp pada toleransi 200: held; +200 bp: matched; kasus 200,4 bp: held (pembulatan).
- dua faktur atas penerimaan yang sama: yang kedua held. Dua create paralel: hanya satu yang matched (kunci PO).
- retur lalu faktur penuh: held. Faktur held lalu retur lalu release: 409 RELEASE_BLOCKED.
- baris jasa: held. PPN > 12% DPP: 422. Nomor dobel: 409.
- release oleh perekam: 403. Release oleh peran purchasing: 403. Release qty-issue: 409. Release harga oleh finance: AP = jumlah faktur.
- matched lalu reject: 409. Toleransi default tanpa baris kebijakan sesuai K1. PUT toleransi 1001: 422; PUT oleh purchasing: 403.

Aturan uang 2, debit note tepat sekali: `purchase-return-ap-open-item.test.ts` PRA-01..08 hijau. Tambahan di `apps/api/src/test/purchase-return-invoiced-split.test.ts`:
- belum-ditagih-dulu (A=10, I=5, retur 3: invoiced 0; I=10, retur 3: invoiced 3 + PPN proporsional).
- retur melebihi sisa utang: 409 dan tidak ada yang tercatat.
- insert settlement debit_note ganda langsung via SQL ditolak unique index.

Aturan uang 3, rollback penuh:
- hapus mapping `accounts_payable`/`grni` lalu create: error `ACCOUNT_MAPPING_MISSING`, nol baris di `purchase_invoices`, lines, `supplier_invoices`, `accounting_open_items`, `journal_entries`, outbox, idempotensi; key yang sama bisa dipakai ulang setelah mapping kembali.
- sama untuk periode tutup, NPWP kosong + PPh 23, dan release yang gagal posting (status tetap held).

Aturan uang 4, isolasi tenant:
- tenant B GET/match/release/reject faktur A: 404.
- create memakai PO/supplier tenant B: 404/422.
- outlet di luar jangkauan: 403.
- RLS langsung di 3 tabel baru.
- `purchasing_policies` tenant B tidak terbaca.

Anti dobel buku (`apps/api/src/test/accounting-asset-no-double-ap.test.ts`):
- jurnal faktur tidak punya baris `fixed_assets`.
- `createFixedAsset` dengan `sourceDocumentId` = id faktur: 409 tanpa jurnal.
- `AUTO_JOURNAL_EVENTS` tidak memuat `supplier_invoice.recorded`.
- saldo GL `accounts_payable` = total aging payable setelah faktur, release, dan debit note.

Migrasi: test migrasi pola yang ada (RLS terpasang, REVOKE/GRANT kolom), `pnpm db:generate` kosong.

## 10. Pembagian file (maks 4 implementer, tidak bertumpuk)

Urutan: I1 dulu (kontrak + skema + migrasi), lalu I2, I3, I4 paralel.

- **I1 kontrak + DB**:
  - `packages/shared/src/inventory/purchasing/{schemas,endpoints,errors,fixtures}.ts`
  - `packages/shared/src/accounting/payables.ts` (bila perlu)
  - `apps/api/src/db/schema/purchasing.ts`, `purchasing.custom.sql`, `accounting-ap-fa.ts`
  - `apps/api/drizzle/0490_*`, `0491_*`, `meta/`
  - `apps/web/src/features/ws06-purchasing/receiving-mock.ts`
  - test fungsi murni `packages/shared` (threeWayMatch: returnedLines, toleransi eksak)
- **I2 faktur + kebijakan (A, B)**:
  - `apps/api/src/services/purchasing-invoice.service.ts`, `purchasing-policy.service.ts`
  - `apps/api/src/routes/purchasing-invoice.routes.ts`, `routes/index.ts`
  - `apps/api/src/config/env.ts` (K5)
  - `apps/api/src/test/purchasing-invoice.test.ts`, `purchasing-policy.test.ts`
- **I3 sisi akuntansi (C, D konsumen)**:
  - `apps/api/src/services/accounting-ap.service.ts`, `accounting-open-items.service.ts`
  - `accounting-auto-journal-consumer.ts` / `accounting-auto-journal-amounts.ts` (**VERIFIKASI** titik sambung)
  - `accounting-fixed-assets.service.ts`
  - `apps/api/src/test/purchase-return-ap-open-item.test.ts`, `accounting-asset-no-double-ap.test.ts`
- **I4 emitter retur (D)**:
  - `apps/api/src/services/purchase-return.service.ts`
  - `apps/api/src/test/purchase-return-invoiced-split.test.ts`

Satu pemegang token heavy sekaligus (diumumkan engineer).

## 11. Keputusan bisnis terbuka (ke founder lewat CTO)

- **K1** Toleransi default tanpa setting: usul **0 bp** (harus sama persis sampai finance mengatur; membatasi bayar). Mockup memakai 200 bp. Batas atas usul 1000 bp (10%).
- **K2** Retur atas faktur yang sudah lunas atau sisa utang kurang: usul **tolak 409**. Alternatifnya piutang ke pemasok (belum ada jenis open item piutang pemasok).
- **K3** Baris jasa pada faktur (ongkir dsb., tidak ada di PO): usul **selalu ditahan** sampai finance merilis.
- **K4** Nilai debit note memakai harga PO (biaya penerimaan), bukan harga faktur; selisih harga pada retur dicatat `legend-1afw0`. Perlu konfirmasi akuntan.
- **K5** Jurnal penerimaan barang (GRNI, `legend-29vw`) belum ada, jadi faktur Dr GRNI akan membuat GRNI bersaldo debit. Usul gate env `SUPPLIER_INVOICE_POSTING_ENABLED` (default mati, nyala bersama `legend-29vw`, seperti gate retur). CTO memutuskan.
- **K6** Batas PPN 12% DPP dan PPh 23 hanya untuk jasa: konfirmasi akuntan (pemasok non-PKP seharusnya PPN 0).
- **K7** Aset dari pembelian (`asset_acquisition` Cr AP) tidak membuat open item AP. Kartu utang tidak memuatnya. Perlu kartu lanjutan.

## 12. Keputusan engineer (13 Nov, berlaku sampai founder menjawab; semua membatasi pembayaran)

- K1: default 0 bp, batas atas 1000 bp. K2: tolak 409. K3: baris jasa selalu held. K4: harga PO. K6: PPN <= 12% DPP, PPh 23 hanya jasa. K7: kartu lanjutan (bukan cabang ini).
- K5: gate env `SUPPLIER_INVOICE_POSTING_ENABLED` default MATI (validasi di `config/env.ts`, pola gate retur `PURCHASE_RETURN_POSTING_ENABLED`). Gate mati: create yang hasilnya `matched`, re-match ke matched, dan release ditolak 409 `SUPPLIER_INVOICE_POSTING_DISABLED` dan TIDAK menulis apa pun (rollback penuh). Faktur yang hasilnya `held` tetap boleh disimpan (tanpa AP). Test menyalakan gate lewat seam `setSupplierInvoicePostingEnabled(true)`.
- Migrasi: 0490 hasil `pnpm db:generate` lalu rename berkas + tag journal ke `0490_<nama>`; 0491 custom SQL (pola cabang batch54 `fix/ai-login-review`: lihat `git log --all --oneline -- apps/api/drizzle/meta/_journal.json`).
- Pemilik file test: test-writer menulis `purchasing-invoice.test.ts`, `purchasing-policy.test.ts`, `purchase-return-invoiced-split.test.ts`, `accounting-asset-no-double-ap.test.ts`; implementer tidak mengubah assert, hanya melapor bila test terasa salah.
- Token heavy: hanya yang diumumkan engineer.
