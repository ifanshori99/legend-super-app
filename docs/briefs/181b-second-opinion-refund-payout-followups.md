# Brief: second-opinion — refund payout followups (ws/refund-payout-followups)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-payout-followups`, cabang `ws/refund-payout-followups`, dibangun di atas `ws/refund-intent-guard` 27ba1fb9 (belum di m1).
Rentang diff: `git diff 27ba1fb9 d2f8c072` (abaikan `docs/briefs/*` dan `docs/PROGRESS.md`). Konteks cabang dasar: `git diff fee69d45 27ba1fb9`.

## Berkas berisiko
- `apps/api/src/services/pos-intent-attribution.ts` (baru)
- `apps/api/src/services/payment-admin.service.ts` (`posSaleInUseOfIntent`)
- `apps/api/src/services/accounting-auto-journal-guards.ts` (`intentBackedAt`)
- `apps/api/src/services/pos-order-payment.ts` (`handlePosPaymentPaid`, capture tender QRIS)
- `apps/api/src/services/accounting-auto-journal-consumer.ts` (ulang parkir SALE_MISSING)
- `docs/runbooks/auto-journal-sale-missing.md`

## Invariant (PRD)
- Uang intent tidak pernah keluar dua kali: refund intent tidak membayar uang yang masih dipakai tender POS (captured, atau authorized pesanan terbuka, termasuk intent lain di payment link yang sama setelah refresh QR).
- Capture tender QRIS tidak terjadi bila refund intent yang sudah disetujui memakai uangnya; tender di-void dan uang lewat jalur refund pembayaran terlambat, tanpa membayar lebih dari yang diterima.
- Jurnal payout intent tidak mengeluarkan dari `customer_deposit` lebih dari penerimaan, dengan memperhitungkan bagian gateway yang dikembalikan refund POS (atribusi per metode yang sama dengan sisi refund).
- Urutan kunci: `payment_intents` (ORDER BY id) sebelum `payment_refunds`; capture: orders → pos_orders → tender → intent. Tidak ada deadlock baru.
- Jurnal refund/void yang parkir menunggu penjualan diulang otomatis setelah penjualan terposting; hanya baris tenant dan pesanan itu.
- Isolasi tenant di setiap query.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
