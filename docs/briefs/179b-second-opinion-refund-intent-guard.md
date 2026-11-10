# 179b: second opinion, refund intent guard (legend-riqu + legend-ni6o)

Tingkat K (uang, jurnal). Read-only. Tulis hasil ke `docs/briefs/179b-second-opinion-refund-intent-guard.result.md` di folder utama (jangan commit).

## Lokasi

- Worktree `.worktrees/refund-intent-guard`, cabang `ws/refund-intent-guard`.
- Rentang: `git diff fee69d45..ws/refund-intent-guard` (basis milestone/m1 fee69d45). Commit: 71ddaf57 (ni6o), e8f1faa4 (riqu), e23edfa5 dan 27ba1fb9 (perbaikan review K). Ujung: 27ba1fb9.
- Konteks: `docs/briefs/179-refund-intent-guard.md`, sub-brief `docs/briefs/sub-179-refund-intent-guard.md` (di worktree), desain `docs/design/auto-journals.md` §4, §10.

## Berkas berisiko

- `apps/api/src/services/payment-admin.service.ts`: `posSaleInUseOfIntent` (SQL CTE), `refundableBalance` (cap kini dikurangi `posSaleInUse`), jalur permintaan refund (409 `REFUND_INTENT_IN_POS_SALE`).
- `apps/api/src/services/payment-refund.service.ts`: `applyApproval` (kunci `lockIntentsForFact`, waktu fakta dari kunci), `capRefusal` (membaca ulang setelah commit untuk memilih kode 409).
- `apps/api/src/services/accounting-auto-journal-amounts.ts`: `order.refunded` menunggu `aj:sale:<orderId>` (`backingStateOf`).
- Test: `payment-refund-pos-tender-guard.test.ts` (baru), `accounting-auto-journal.test.ts` (AJ-REFUND-N1..N3, AJ-REFUND-01 diubah).

## Invarian yang harus benar

1. Uang intent yang masih membayar tender POS `captured` tidak bisa direfund lewat refund intent (permintaan, approval satu tingkat, approval berantai, listing refundable, refund pembayaran terlambat).
2. Bagian gateway yang sudah diretur lewat refund POS (`pos_order_refunds.lines`, metode sama) dibebaskan hanya bila semua tender metode itu di pesanan tersebut memakai intent yang sama; selain itu fail closed.
3. Pemeriksaan approval berjalan di bawah kunci `payment_intents FOR UPDATE`; `decidedAt`, `updatedAt`, audit, dan kegagalan memakai waktu fakta dari kunci.
4. Kegagalan approval tetap `cap_exceeded` (tidak ada alasan baru, tanpa migrasi); API menjawab 409 `REFUND_INTENT_IN_POS_SALE` bila tender POS penyebabnya.
5. Pesanan ber-void (`pos_order_voids`) tidak menahan intent; retur POS penuh satu metode membebaskan semua intent metode itu; tender `authorized` pada pesanan terbuka ikut menahan, tender `authorized` pada pesanan final (late payment) tidak.
6. `order.refunded` tidak memposting sebelum jurnal penjualan posted: pending → parkir `AUTO_JOURNAL_SALE_PENDING` (retryable, sweep), none → `AUTO_JOURNAL_SALE_MISSING` (non-retryable), sama dengan void.

## Pertanyaan

1. Apakah SQL `posSaleInUseOfIntent` benar untuk pesanan multi-tender, multi-pesanan per intent, refund POS sebagian berkali-kali, tender voided/failed, dan metode campuran? Ada jalur tamu dibayar dua kali?
2. Jendela sisi penjualan: tender captured sesudah approval refund (di `pos-order.service.ts`, di luar scope) apakah memeriksa saldo intent di bawah kunci yang sama? Seberapa nyata risikonya?
3. `capRefusal` membaca di luar transaksi setelah commit: bisakah kode 409 salah pilih (mis. tender berubah di antara), dan apakah itu hanya salah pesan atau bisa salah uang?
4. Penjualan parkir non-retryable (`POSTING_AMOUNTS_MISMATCH`) membuat refund parkir `SALE_MISSING` non-retryable. Setelah ops memperbaiki penjualan, apakah refund ikut terposting, atau perlu re-drive manual? Apakah itu dapat diterima?
5. Apakah ada pemanggil `refundableBalance` lain yang kini salah karena cap turun (deposit reservasi, QR pay-first, payout refund POS gateway)?

Sudah dicatat sebagai bead (jangan diulang kecuali kamu tidak setuju): legend-r5brx (capture tender tanpa kunci intent), legend-hxpd5 (guard GL payout tanpa retur POS), legend-3bsyh (parkir SALE_MISSING tidak diulang), legend-8v2yl (baris refund POS per tender).

Format hasil: temuan nyata saja, `berkas:baris`, tingkat (tinggi/sedang/rendah), skenario konkret, saran perbaikan.
