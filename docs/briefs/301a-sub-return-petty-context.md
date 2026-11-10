# 301a: konteks bersama retur supplier dan pembelian sederhana (legend-65mgw, tingkat K uang)

Brief induk: `docs/briefs/301-supplier-return-petty-emitter.md` di folder utama (`/Users/ifanshori99/Projects/legend super app/legend/docs/briefs/`). Worktree `.worktrees/purchase-return-posting`, cabang `ws/supplier-return-petty`. Migrasi `0208`, `when` 1794287000000, prevId = snapshot 0205 (idx 205 `0205_purchase_return_posting`). Keputusan jurnal sebelumnya: `docs/DECISIONS.md` bagian "WS-07: purchase return and petty purchase journals".

## Temuan peta kode (path di `apps/api/src` kecuali disebut)
Penerimaan barang (template):
- `db/schema/inventory-receiving.ts`: `goodsReceipts` :44, `goodsReceiptLines` :108, `goodsReceiptMedia` :210. Unik `(tenant,id)`, `(tenant,outlet,id)`, `(tenant,number)`. Nomor `GR/YYYYMM/NNNN` dari `purchasingDocumentSequences` (kind "GR"), `nextGrNumber` service :225-250. Retur memakai kind lain (mis. "PR").
- Idempotensi: tabel `purchasing_idempotency`; `claimPurchasingIdempotency`, `completePurchasingIdempotency` di `services/purchasing-flow.shared.ts` :309/:338; fingerprint `requestFingerprint(op, actor, canonicalInput)` service :493.
- `services/inventory-receiving.service.ts` `createGoodsReceipt` :486-818: assertOutlet; withTenant; `requireOpsPermission`; claim idempotensi; kunci PO; validasi baris/lokasi; `loadOutletClock` tanggal bisnis; nomor; insert header+baris; stok; audit; `appendReceiptRecordedEvent` :438 (`purchasingEvents[name].envelopeSchema.parse` lalu `appendOutbox`); complete idempotensi; error lewat `translatePurchasingError(translateInventoryError(e))`.
- Stok keluar: `recordStockMovementInTransaction` dengan `movementType "return"`, `sourceType "purchase_return"`, `quantity < 0` (constraint `db/schema/inventory.ts:391,406,417`). Tanpa `unitCostIdr` dipakai `avgCostIdr` saldo (`inventory.service.ts:1017-1025`). Guard stok negatif: `INSUFFICIENT_STOCK` (`inventory-ops.shared.ts:330`). Kunci idempoten per baris: `goods_receipt:${receipt.id}:${line.id}` (retur: `purchase_return:${id}:${line.id}`).
- Route template: `routes/inventory-receiving.routes.ts:33-70` (requireAuth, requireTrustedOrigin, requireTenantContext, jsonBody, `requireOutletPermission(perm, bodyOutlet)`, 201 `{data}`); registrasi `routes/index.ts:13,:162`.
- Tes template: `test/inventory-receiving.test.ts` (`tenantContext`, `grantRoles`, `signedIn`, `seedFixture`, `receive`, `ledgerOf`, `eventRows`, `asScope`).
- Helper tes jurnal ujung ke ujung: `test/accounting-purchase-return-journal.test.ts` (`makeTenant`, `makeWorld`, `deliver`, `envelope`, ...) file-lokal, belum diekspor.

Kontrak shared (`packages/shared/src/inventory/purchasing/`):
- `schemas.ts`: `pettyPurchasePolicySchema` :1700 (outletId nullable = default tenant, `limitIdr`), `pettyPurchaseLimitFor` :1711, `assertPettyPurchaseWithinLimit` :1727 (limit null = tolak; `PETTY_PURCHASE_LIMIT_EXCEEDED`), `pettyPurchaseSchema` :1748 (`photoMediaId`, paidBy, paidAt, businessDate), `purchaseReturnReasonSchema` :1600, `purchaseReturnValueIdr` :1652, `assertPurchaseReturnWithinReceipt` :1667.
- `endpoints.ts`: `createPurchaseReturnInputSchema` :364, `createPettyPurchaseInputSchema` :376 (keduanya punya `idempotencyKey`); read endpoints :499-531 termasuk `getPettyPurchasePolicy` GET `/api/inventory/petty-purchase-policy`; write :658, :665. Tidak ada endpoint tulis policy.
- `errors.ts`: `PURCHASE_RETURN_EXCEEDS_RECEIPT` (409) dan `PETTY_PURCHASE_LIMIT_EXCEEDED` (409).
- Izin: `packages/shared/src/access/permissions.ts` :150-153 dan `access/roles.ts` :198, :446-448; belum ada `purchasing.return.*` atau `purchasing.petty.*`.
- Foto: `routes/core-storage.routes.ts` (multipart, 10MB), tujuan `receipt` private di `packages/shared/src/storage/index.ts:26-29`, `storageSourceKindPurpose` :53; `db/schema/core-storage.ts:16` `core_storage_objects` (outletId, ownerUserId, sourceKind, sourceId). `photoMediaId` mengacu id ini.

Migrasi/RLS: contoh `drizzle/0173_goods_receipts.sql:86-99` (`app.enforce_tenant_rls`, `app.enforce_outlet_rls`; lihat komentar :86-88 untuk revoke UPDATE/DELETE pada riwayat tak berubah). Tes RLS: `src/db/rls.test.ts:45`, `src/test/migration-force-rls-guard.test.ts`, `migration-fk-force-rls.test.ts`. Idempotensi kontrak: `docs/plan/contracts.md:224-234` (409 `IDEMPOTENCY_KEY_REUSED`).

Penahan: tidak ada flag "jurnal penerimaan barang ke GRNI aktif". `isModuleEnabled(featureFlags, ...)` dari `@starter/shared/platform` membaca `tenants.featureFlags` (pola `inventory-gl-consumer.ts:170-180`). `config/env.ts:184` hanya punya `DOIT_REFUNDS_ENABLED`.

## Fakta penting
- Belum ada tabel faktur supplier di m1: `invoicedValueIdr` dan `ppnIdr` = 0 sementara, `uninvoicedValueIdr = valueIdr`. Pembagian per baris dibulatkan per baris (jumlah baris = total).
- Event retur wajib memuat `outletId`, `uninvoicedValueIdr`, `invoicedValueIdr`, `ppnIdr` (kontrak sudah di `events.ts`). Event petty: `petty_purchase.recorded` id-only (`pettyPurchaseId, outletId, amountIdr, businessDate, paidBy, paidAt`).
- Scope: jangan kas kecil (`legend-4961`), pembayaran/faktur supplier, jurnal penerimaan barang, UI.
