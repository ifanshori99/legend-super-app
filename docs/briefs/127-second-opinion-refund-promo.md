# Brief: second-opinion — refund parsial pesanan berpromo (legend-q1e0, legend-9be7, legend-15by, legend-wkl3)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-promo`, cabang `ws/refund-promo`, SHA `e3d5f56e`.
Rentang diff: `git diff 0f7e4ff6 e3d5f56e` (`0f7e4ff6` = tip `milestone/m1` saat cabang dibuat; isi cabang saja). Abaikan `apps/api/drizzle/meta/*.json` dan `docs/`. Satu run: 747 baris non-test (+633/−114). Test boleh dibaca untuk konteks, tidak dihitung.

## Berkas berisiko
- `apps/api/src/services/crm-promo-refund.ts` (hitung ulang promo setelah refund parsial: diskon yang disimpan per baris, payout kumulatif, `deferPayout`, `recordPartialRefundPayout`)
- `apps/api/src/services/order-promo-refund.ts` (port yang dipakai modul refund; menurunkan baris `promotion_redemptions` dan `promotions.spent_idr` per baris; `livePromoApplicationOf`)
- `apps/api/src/services/pos-order-corrections.ts` (`refundPosOrder`: validasi `items`, payout level tagihan dengan pajak/servis/pembulatan, deposit, diskon manual, batas sisa tender)
- `apps/api/src/services/pos-order-ports.ts` (port refund promo yang bisa diganti di test)
- `apps/api/drizzle/0105_natural_kylun.sql`, `apps/api/drizzle/0106_slim_human_cannonball.sql`, `apps/api/src/db/schema/pos-order.ts` (`pos_order_refunds.items`; check amount/lines untuk baris Rp0)
- `apps/api/src/services/pos-day.service.ts`, `apps/api/src/services/pos-receipt-document.ts` (rekap harian dan status invoice mengabaikan baris Rp0)
- `apps/api/src/services/pos-order-support.ts` (allowlist field audit)
- `packages/shared/src/pos/endpoints.ts`, `packages/shared/src/pos/schemas.ts` (body `items` opsional, respons `items`, respons Rp0)

## Invariant
- Aturan founder 1: promo masih sah setelah refund → refund item = harga item dikurangi bagian diskonnya secara pro-rata menurut harga. Contoh: subtotal 100k (2 × 50k), diskon 20k, dibayar 80k; refund satu item 50k → 40k.
- Aturan founder 2: syarat promo tidak lagi terpenuhi → promo batal, item yang disimpan dihitung harga normal, refund = dibayar − harga normal item yang disimpan (min 0). Contoh yang sama dengan promo min-belanja 100k → 30k.
- Founder Q19: item gratis yang dikembalikan menghasilkan Rp0 (beli 2 kopi gratis 1 croissant; croissant gratis dikembalikan → Rp0).
- Keputusan CTO legend-wkl3: retur Rp0 tetap dicatat sebagai baris refund `amount_idr = 0`, `lines = []`, `items` terisi, audit; respons sukses; tanpa gateway, tanpa event `order.refunded`, tanpa ledger payout, tanpa membalik stok; idempoten. Rp0 hanya bila tagihan tidak lagi berutang apa pun ke tamu; masih berutang tetapi tender habis → 422 `REFUND_NOTHING_DUE` dan tidak ada yang tertulis. Rekap harian dan status invoice tidak berubah karena retur Rp0.
- Total refund tidak bergantung pada cara tamu membagi pengembalian (dua refund berturut-turut = satu refund dengan item yang sama).
- Idempotensi: kirim ulang dengan `idempotencyKey` yang sama tidak membuat baris refund kedua, tidak membayar dua kali, tidak mengubah promo/budget lagi.
- Tidak bayar ganda: jumlah semua payout ≤ yang dibayar tamu lewat tender; `refunded_paid_idr` mencatat payout sebenarnya, bukan yang diminta kasir.
- `sum(promotion_redemptions.discount_idr applied)` == `promotion_order_applications.total_discount_idr` setelah tiap refund; `spent_idr` tidak pernah negatif dan hanya turun sebesar diskon yang benar-benar tidak lagi diberikan.
- Port gagal → seluruh refund batal (tidak ada baris refund, promo, budget, atau ledger yang berubah). Pesanan berpromo tanpa `items` ditolak.
- Refund tidak membalik stok (hanya void).
- Isolasi tenant di setiap query; urutan kunci: baris pesanan POS → advisory lock per pesanan → baris aplikasi promo → voucher → promosi.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal dengan angka, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
