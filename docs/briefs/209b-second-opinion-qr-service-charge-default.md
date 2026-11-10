# 209b — Second opinion: QR service charge default (legend-xx22n)

Tingkat K (uang dan pajak). Read-only. Laporan: temuan nyata dengan file:line dan langkah reproduksi, atau "tidak ada".

## Rentang
- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/qr-service-charge-default`, cabang `ws/qr-service-charge-default`, base `milestone/m1` (94d769c6).
- Diff: `git diff milestone/m1...ws/qr-service-charge-default` (test baru saja: `apps/api/src/test/qr-service-charge-default.test.ts`).

## Berkas berisiko (baca)
- `apps/api/src/services/qr-order-pricing.ts` (`loadTaxConfig` ~436, `selectServiceChargeRules` ~560, `buildQuote` ~640-818)
- `apps/api/src/services/pos-order-pricing.ts` (`computePosBill` ~312)
- `apps/api/src/services/qr-order.service.ts` (~920-960, checkout ~1756)
- `apps/api/src/services/guest-menu.service.ts` (`readGuestTaxNote` ~526)
- `apps/api/src/services/tax-provisioning.service.ts` (default SC-DINE-IN ~240-330)
- `packages/shared/src/tax/calculate.ts` (`resolveServiceChargeRule` ~166)

## Invariant
1. Tenant/outlet baru dengan provisioning default, QR dine-in, zona `serviceChargeBp=0`, subtotal Rp100.000: service Rp5.000, PBJT Rp10.500, total Rp115.500 di quote dan di baris `orders` hasil checkout.
2. Zona dengan `serviceChargeBp>0` menimpa aturan outlet/tenant.
3. QR dan POS untuk keranjang, zona, dan channel yang sama memberi service, pajak, dan total yang sama.
4. Take-away tidak kena SC-DINE-IN. Aturan service satu tenant tidak terbaca tenant lain.

## Pertanyaan
Temukan jalur nyata (pembuatan tenant lewat panel, outlet baru lewat org service, tanggal bisnis/effectiveFrom, versi/tombstone, aturan ambigu, open bill, inclusive, promo) di mana invariant di atas gagal pada kode cabang ini.
