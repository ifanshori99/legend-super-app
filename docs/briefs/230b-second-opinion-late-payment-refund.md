# Brief: second-opinion — refund pembayaran terlambat dan bagian gateway refund POS (legend-ghgei, tier K)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/late-payment-refund-refile`, cabang `ws/late-payment-refund-refile`.
Rentang diff: `git diff c75b0d98..ws/late-payment-refund-refile` (base = `ws/pos-order-replay-zone-charge` c75b0d98, sudah diperiksa terpisah). Jangan pakai `merge-base main`. Tidak ada migrasi.
Latar: refund QRIS yang ditolak approver tidak diajukan ulang oleh sistem; bagian gateway dari refund POS dulu hanya dibayar bila admin membuat refund intent manual. Temuan "refund staf untuk QR intent ber-orderId gagal source_document" tidak terjadi di production: tidak ada kode yang mengisi `payment_intents.order_id` (insert tunggal `payment.service.ts:744`), jadi refund staf sudah bisa diajukan ulang; dibuktikan dengan test regresi.

## Berkas berisiko
- `apps/api/src/services/pos-refund-gateway.ts` (baru): `requestPosRefundGatewayPart` mengajukan refund WS-05 `system:pos` per intent untuk baris refund POS bermetode gateway; lewati intent EDC; jumlah = min(jumlah baris, cap - reserved); kekurangan diaudit `pos_order.refund_gateway_shortfall`; kunci idempoten `pos-refund-gateway:<posRefundId>:<intentId>`.
- `apps/api/src/services/pos-order-corrections.ts`: dipanggil setelah insert `pos_order_refunds`, hanya bila `!goodsReturnOnly`.
- `apps/api/src/services/payment-refund.service.ts`: empat mata, yaitu pembuat dan penyetuju refund POS tidak boleh menyetujui payout gateway-nya (`assertNotPosRefundParty` / pemeriksaan di settle chain dan `approvalDefectOf`).
- `apps/api/src/services/payment-admin-idempotency.ts`: kunci berawalan sistem (`pos-late-payment-refund:`, `qr-late-payment-refund:`, `pos-refund-gateway:`, `reservation-refund:`) ditolak 422 `IDEMPOTENCY_KEY_RESERVED` untuk aktor bukan `system:*`.
- Test: `apps/api/src/test/pos-refund-gateway-autofile.test.ts`, `pos-refund-gateway-multi-intent.test.ts`, `late-payment-refund-refile.test.ts`.

## Invariant
- Uang tamu tidak pernah dibayar dua kali: jumlah semua refund intent (pending, approved, completed) tidak pernah melebihi cap `refundableBalance`; replay refund POS tidak mengajukan refund kedua; refund manual admin di atas sisa ditolak; intent EDC tidak pernah mendapat refund gateway.
- Uang tamu tidak tertahan diam-diam: refund gateway yang ditolak atau kedaluwarsa menjadi `failed` dan cap bebas lagi sehingga staf bisa mengajukan ulang; kekurangan selalu tercatat di audit.
- Empat mata: pembuat atau penyetuju refund POS tidak bisa menyetujui payout gateway-nya lewat jalur mana pun (approve langsung, langkah chain lewat inbox `/approvals/:id/decisions`, settle chain, revalidasi sweep/retry). Refund tidak pernah macet `pending` karena penolakan ini.
- Refund POS tidak gagal karena pengajuan gateway (kegagalan membuka chain ditelan `openRefundChainSafely`).
- Urutan lock: order, pos_orders, shift, intent naik, kunci advisory, deposit; tidak ada siklus dengan jalur pembayaran.
- Jurnal otomatis konsisten: `order.refunded` mengkredit `customer_deposit` sebesar `refundGatewayIdr`, `payment.refunded` mendebit jumlah yang sama.
- Kunci idempoten sistem tidak bisa diambil lebih dulu oleh pengguna; filer sistem yang ada (`system:pos`, `system:qr`, `system:reservation`) tetap jalan.
- Hanya tenant dan outlet milik refund yang tersentuh (TEN-01/TEN-02).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
