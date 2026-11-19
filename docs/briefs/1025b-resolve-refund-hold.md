# Brief 1025b: finance resolve refund_recon_holds (bead legend-vp4ta, P1)

Branch: ghostex/5e374ac9 di atas d18b82fa8. Tingkat K (uang, izin). Keputusan CTO: dikerjakan sebelum rilis. Beads lain: legend-t9g3i (poller, P2), legend-tiyce (refund fund menutup semua, P2) hanya dicatat, tidak dikerjakan.

## Yang ada

Tabel `refund_recon_holds` (migrasi 0642, schema `apps/api/src/db/schema/refund-recon-holds.ts`): tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason, flagged_at, resolved_at. Hold terbuka (resolved_at NULL) memblokir refund, payout, dan fund pada intent lewat `payment-provider-refunded-guard.ts` (`fundBlockedSql`, `providerRefundedBlocks`, `refundBlockedByProviderRefundSql`). Tidak ada kode yang mengisi `resolved_at`.

## Yang dibangun

Endpoint finance untuk menutup (resolve) satu hold:

- Izin finance yang sudah ada (cek `packages/shared/src/permissions.ts`; pakai `requireTenantPermission` atau `requireOutletPermission` seperti rute refund/payment-admin yang ada), `requireAuth`, `requireTrustedOrigin`, `jsonBody`.
- Body strict zod di `packages/shared/src/validators/`: alasan wajib (min panjang), keputusan yang dicatat (mis. `matched_no_action` / `matched_refund_recorded`; tentukan minimal yang aman).
- Idempoten: resolve ganda tidak mengubah apa pun dan tidak menggandakan audit (balas 200 dengan keadaan sama atau 409 yang jelas; pilih satu, uji).
- Tenant lain: 404. Tanpa izin: 403. Hold tidak ada: 404.
- Audit: pola audit refund/payment yang ada (`appendPaymentEvent` / audit log).
- Hanya membuka blokir. TIDAK membuat refund, TIDAK menyetel stamp, TIDAK membayar apa pun. Setelah resolve, blok refund/payout intent turun hanya bila tidak ada hold terbuka lain dan flag lain tidak menahan.
- Daftar hold terbuka (GET) bila perlu untuk UI. UI hanya bila layar finance yang ada sudah punya tempatnya; layar baru: berhenti dan lapor.

## Test wajib

Resolve membuka blok refund/payout sekali; tidak membayar lebih (refund melebihi sisa tetap ditolak); resolve ganda; hold lain tetap memblokir; tenant lain 404; tanpa izin 403; alasan kosong 422; kontrol 1025-a/b/c, 1020, 958, 967, 1013, 1016 hijau. Gagal-dulu di base. Berkas: `src/test/refund-1025-d-resolve-hold.test.ts`.
Migrasi hanya bila perlu (nomor kerja 0649-0650).

## Rancangan (diputuskan engineer, hasil peta Explore)

Kontrak di `packages/shared/src/payment/admin.ts` (bukan validators/), mengikuti `resolveUnallocatedFund` (:931) dan rute `payment-admin.routes.ts:393` (`jsonBody`, `reconcileRecord` = `requireMenuPermission("payment.reconcile")`, mount `/api/payments/admin`):

- `listRefundReconHolds`: GET `${ADMIN}/refund-recon-holds` (query: status `open|resolved`, cursor), izin `payment.reconcile` (`reconcileQuery`).
- `resolveRefundReconHold`: POST `${ADMIN}/refund-recon-holds/:holdId/resolve`, body strict `{ idempotencyKey, resolution: "not_this_intent" | "counted_against_intent", note }` (`noteSchema`, wajib).
- Layanan baru `refund-recon-hold.service.ts` (di dalam `withTenant`; kunci intent via `lockIntentsForFact`; `UPDATE ... SET resolved_at, resolved_by, resolution, resolution_note WHERE tenant_id AND id AND resolved_at IS NULL RETURNING`; audit + `appendPaymentEvent` hanya bila baris kembali). Resolve ganda: 409 `CONFLICT` "Hold already resolved." (pola fund :312); hold tidak ada / tenant lain: 404.
- JANGAN membuka blokir begitu saja (risiko bayar lebih): `not_this_intent` = finance memastikan uang yang dikembalikan provider bukan milik intent ini, hanya menutup hold. `counted_against_intent` = uang itu milik intent: catat sebagai refund provider lewat `recordProviderRefundInTx` (quiet, provider_refund_id hold, amount_idr hold, source refund_webhook; idempoten lewat kunci unik) SEBELUM hold ditutup, sehingga batas refund/payout (intentOverNetSql, refundableBalance) dan jurnal 1013 menghitungnya. Hold yang `provider_refund_id` NULL atau amount 0 hanya boleh `not_this_intent`. Hold `payment:<ref>` (refund kita jalan saat refund penuh): hanya `counted_against_intent` tanpa baris baru bila baris `payment:<ref>` sudah ada; selainnya `not_this_intent` ditolak 422 (restriktif: tidak melepas uang yang mungkin sudah kembali).
- Kolom baru `resolved_by` (uuid user), `resolution` (text check), `resolution_note` pada `refund_recon_holds`: migrasi 0649 (tabel belum di main, boleh menambah kolom lewat ALTER di migrasi baru).
- UI: tab ke-6 "Hold refund" di `apps/web/src/features/ws05-payment-admin/components/payment-admin-page.tsx` (ikuti `unallocated-panel.tsx`, `ResolveFundDialog`, `newIdempotencyKey`, hooks.ts:224). Tidak perlu layar baru. Diaudit `ui-auditor`.
