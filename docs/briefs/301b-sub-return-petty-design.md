# 301b: desain retur supplier dan pembelian sederhana (keputusan architect, 10 Nov 2026)

Baca dulu `docs/briefs/301a-sub-return-petty-context.md` (peta kode). Semua path relatif ke worktree. Nama ekspor drizzle tetap: `purchaseReturns`, `purchaseReturnLines`, `pettyPurchases`, `pettyPurchasePolicies`. Kolom uang: pakai helper kolom IDR yang dipakai `inventory-receiving.ts`.

## 1. Tabel (migrasi `apps/api/drizzle/0208_supplier_return_petty.sql`, `when` 1794287000000, prev = snapshot 0205)
- `purchase_returns`: tenant_id, outlet_id NOT NULL, id, goods_receipt_id NOT NULL, purchase_order_id NOT NULL, supplier_id, number varchar(40), reason (CHECK 6 nilai enum `purchaseReturnReasonSchema`), returned_on date, returned_at, returned_by (user), value_idr, uninvoiced_value_idr, invoiced_value_idr, ppn_idr, note varchar(300), created_at. CHECK: value = uninvoiced + invoiced; ppn = 0 OR invoiced > 0; semua >= 0. Unik (tenant,id), (tenant,outlet,id), (tenant,number). FK (tenant,outlet,goods_receipt_id) ke goods_receipts, supplier, PO, outlet. Index (tenant,outlet,returned_at,id), (tenant,goods_receipt_id).
- `purchase_return_lines`: tenant, outlet, id, purchase_return_id, goods_receipt_line_id NOT NULL, purchase_order_line_id NOT NULL, inventory_item_id, location_id, batch_id null, batch_code, quantity decimal4 > 0 (satuan dasar), unit_cost_idr decimal4 >= 0, line_value_idr >= 0, line_no. Unik (tenant,return,goods_receipt_line_id), (tenant,return,line_no). Index (tenant,goods_receipt_line_id).
- `petty_purchases`: tenant, outlet NOT NULL, id, vendor_name(150), description(200), amount_idr > 0, photo_object_id NOT NULL, paid_by, paid_at, business_date, limit_idr_applied, note, created_at. FK (tenant,photo_object_id) ke core_storage_objects; UNIQUE (tenant,photo_object_id). Index (tenant,outlet,business_date,id).
- `petty_purchase_policies`: tenant, id, outlet_id NULL (null = default tenant), limit_idr > 0, updated_by, updated_at, created_at. Dua unique parsial: (tenant) WHERE outlet IS NULL; (tenant,outlet) WHERE outlet NOT NULL.
- RLS: tiga tabel riwayat (`purchase_returns`, `purchase_return_lines`, `petty_purchases`): `app.enforce_tenant_rls` + `app.enforce_outlet_rls`, lalu `REVOKE UPDATE, DELETE, TRUNCATE ... FROM legend_app` (ikuti `0173_goods_receipts.sql:86-99`). Policy: hanya tenant RLS, `REVOKE DELETE, TRUNCATE` (UPDATE boleh, diaudit).
- Di migrasi yang sama: perlebar `purchasing_document_sequences_kind_check` ke ('PO','GR','RT'); tambah 'petty_purchase' ke `core_storage_objects_source_kind_check`; backfill baris role template untuk izin baru (pola NO FORCE/FORCE dari 0172).

## 2. Alur retur `createPurchaseReturn` (`services/purchase-return.service.ts`)
1. assertOutlet; gerbang (butir 3); withTenant; `requireOpsPermission("purchasing.return.create")`; klaim idempotensi op `purchase_return.create`.
2. `goodsReceiptId` dan tiap `purchaseOrderLineId` wajib, selain itu 422 VALIDATION_ERROR (kontrak opsional, service lebih ketat).
3. Kunci header penerimaan `SELECT ... FOR UPDATE` (semua retur mengunci ini dulu, jadi retur bersamaan serial). Tidak ada atau outlet salah: 404. supplierId harus cocok; purchaseOrderId bila dikirim harus cocok.
4. Cocokkan tiap baris ke baris penerimaan lewat `purchaseOrderLineId`; item harus sama; baris ganda dalam satu request 422.
5. Batas: jumlahkan qty dan nilai retur sebelumnya per baris penerimaan. Qty lama + baru <= `accepted_base_quantity`, jika tidak 409 PURCHASE_RETURN_EXCEEDS_RECEIPT.
6. Qty dalam satuan dasar item (satuan ledger stok). Tulis komentar kontrak.
7. Biaya stok = biaya penerimaan: `baseUnitCost(grLine.unitCostIdr, accepted, acceptedBase)` (ekspor dari `inventory-receiving.service.ts`), bukan rata-rata bergerak.
8. Nilai baris kumulatif: `grLineValue = extendCostIdr(accepted, grLine.unitCostIdr, half_up)`; `lineValue = divideRounded(grLineValue × (priorQty+qty), acceptedBase, half_up) − priorValue`. Retur penuh membersihkan GRNI baris itu tepat. `valueIdr` = jumlah nilai baris (bukan `purchaseReturnValueIdr`).
9. Split: `uninvoicedValueIdr = valueIdr`, `invoicedValueIdr = 0`, `ppnIdr = 0` (belum ada faktur supplier).
10. `returnedOn` antara receivedOn penerimaan dan tanggal bisnis outlet (`loadOutletClock`), jika tidak 422. Nomor `RT/YYYYMM/NNNN` dari `purchasingDocumentSequences` kind "RT".
11. Stok keluar, baris diurut (location, item, lineNo): `recordStockMovementInTransaction` `movementType "return"`, `sourceType "purchase_return"`, quantity negatif, biaya penerimaan, `batchId` baris penerimaan; kunci `purchase_return:${id}:${line.id}`. Lokasi: salah satu lokasi outlet; tidak cukup stok: 409 INSUFFICIENT_STOCK. `batchCode` klien harus null atau sama dengan baris penerimaan.
12. Audit `purchasing.return_recorded`; `appendOutbox` event `purchase_return.recorded` (key `${name}:${id}:1`, aggregateType `purchase_return`, payload lengkap termasuk outletId dan split); selesaikan idempotensi. Error lewat `translatePurchasingError(translateInventoryError(e))`.

## 3. Gerbang retur
- Env `PURCHASE_RETURN_POSTING_ENABLED` di `config/env.ts` (pola `DOIT_REFUNDS_ENABLED`), default MATI. Seam tes `setPurchaseReturnPostingEnabled(bool)` di service retur.
- Mati: seluruh POST ditolak (bukan hanya event), karena stok keluar tanpa jurnal memisahkan GL dari stok. Dicek SEBELUM klaim idempotensi. 403 `FEATURE_DISABLED` (kode core yang ada), pesan "Retur pembelian belum aktif sampai jurnal penerimaan barang (legend-29vw) berjalan". GET tetap terbuka. `legend-29vw` yang menyalakan.

## 4. Alur pembelian sederhana `createPettyPurchase` (`services/petty-purchase.service.ts`; tanpa gerbang)
1. Izin `purchasing.petty.record`; klaim idempotensi op `petty_purchase.create`.
2. `businessDate = businessDateOf(now, loadOutletClock)`. businessDate klien berbeda: 422 (tanpa mundur tanggal). `paidAt` default sekarang; harus <= sekarang dan di tanggal bisnis yang sama, jika tidak 422.
3. Batas: baca baris tenant dan outlet, `pettyPurchaseLimitFor` lalu `assertPettyPurchaseWithinLimit`. Melebihi atau tanpa kebijakan: tolak 409 PETTY_PURCHASE_LIMIT_EXCEEDED. Tidak ada jalur persetujuan. Simpan batas di `limit_idr_applied`.
4. Insert baris, lalu `linkStorageObjectSource(tx, {sourceKind:"petty_purchase", sourceId:id, objectId:photoMediaId, actorUserId, outletId})` (purpose receipt, outlet sama, uploader = actor, belum ditautkan; gagal = 422).
5. Audit; `appendOutbox` `petty_purchase.recorded` (payload id-only: pettyPurchaseId, outletId, amountIdr, businessDate, paidBy, paidAt); selesaikan idempotensi.
6. Kebijakan: `PUT /api/inventory/petty-purchase-policy` body `{outletId|null, limitIdr, idempotencyKey}` upsert, diaudit. GET mengembalikan kebijakan efektif atau 404.

## 5. Izin (`packages/shared/src/access/permissions.ts`, `roles.ts`)
- `purchasing.return.create` (tag []): owner (otomatis), purchasing, warehouse.
- `purchasing.petty.record` (tag []): owner, general_manager, outlet_manager, kitchen_lead, purchasing.
- `purchasing.petty_policy.manage` (tag ["finance"]): owner, finance.
- Baca retur: salah satu [return.create, invoice.match]; baca petty: salah satu [petty.record, accounting.reconcile]; GET kebijakan: salah satu [petty.record, petty_policy.manage].
- `storageSourcePermissionMap.petty_purchase`: upload [petty.record], baca [accounting.reconcile, petty_policy.manage]. Tambah `petty_purchase` ke `storageSourceKindSchema` dan `storageSourceKindPurpose` ("receipt") di `packages/shared/src/storage/index.ts`; map akses di `services/core-storage-access.ts`.

## 6. Route (sesuai `endpoints.ts`; POST 201 `{data}`)
- GET dan POST `/api/inventory/purchase-returns`; GET `/api/inventory/purchase-returns/:purchaseReturnId`.
- GET dan POST `/api/inventory/petty-purchases`; GET `/api/inventory/petty-purchases/:pettyPurchaseId`.
- GET `/api/inventory/petty-purchase-policy?outletId=`; PUT (baru; tambah endpoint dan input schema di `endpoints.ts`). outletId null: `requireTenantPermission`, selain itu `requireOutletPermission`.

## 7. Potongan kerja
- A fondasi (duluan): `db/schema/purchase-returns.ts`, `db/schema/petty-purchases.ts` (baru), `db/schema/index.ts`, `db/schema/purchasing.ts` (kind check), `db/schema/core-storage.ts` (source kind check), `drizzle/0208_*.sql`, `meta/_journal.json`, `meta/0208_snapshot.json`, `config/env.ts`, `packages/shared/src/access/permissions.ts`, `access/roles.ts`, `storage/index.ts`, `inventory/purchasing/endpoints.ts` (PUT), `services/core-storage-access.ts`.
- B retur: `services/purchase-return.service.ts`, `routes/purchase-return.routes.ts`, `test/purchase-return.test.ts`, hanya ekspor `baseUnitCost` di `services/inventory-receiving.service.ts`.
- C petty: `services/petty-purchase.service.ts`, `routes/petty-purchase.routes.ts`, `test/petty-purchase.test.ts`.
- D pemasangan (sesudah A): `routes/index.ts` (daftarkan dua router), `db/rls.test.ts` (baca lintas tenant/outlet, UPDATE/DELETE ditolak di tabel riwayat), snapshot tes katalog/role bila gagal.

## 8. Risiko (catat di laporan dan bead tindak lanjut)
- Rata-rata bergerak tidak berubah saat stok keluar: nilai stok (qty × avg) bisa melenceng dari GL persediaan sebesar q × (biaya penerimaan − avg).
- Penerimaan sebelum jurnal GRNI aktif: retur akan mendebit GRNI yang tak pernah dikredit; `legend-29vw` harus menambah penjaga cutover.
- Satuan salah (UI kirim satuan beli) merusak stok.
- Batas petty per transaksi, bisa diakali dengan banyak transaksi kecil.
- Belum terverifikasi: `enforce_outlet_rls` pada outlet_id nullable (policy pakai tenant RLS saja), FK ke core_storage_objects FORCE RLS saat migrasi, tes snapshot matriks akses.
