# Brief: engineer — perbaikan review K ws/refund-approval (5b6a707)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/refund-approval`, cabang `ws/refund-approval`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Tinggi — `services/payment-refund.service.ts:270-363`: refund provider `completed` hanya kirim `payment.refunded`, yang sengaja tidak memposting (`packages/shared/src/accounting/posting-rules.ts:16-18`); jurnal refund hanya dari `order.refunded` (`pos-order-corrections.ts`). Uang keluar tanpa jurnal balik → GL dan rekonsiliasi gateway selisih. Batas refund juga terpisah: POS refund tidak membaca `payment_refunds`, `refundableBalance` tidak membaca `pos_order_refunds` → satu tagihan bisa dikoreksi dua jalur melebihi bayar. Fix: jurnal balik idempoten per `refundId` saat completed (kirim `order.refunded` atau aturan posting `payment.refunded`), dan batas refund gabungan kedua tabel di bawah kunci yang sama. Test: refund gateway → jurnal balik; POS refund + gateway refund tidak melebihi bayar.
2. Sedang — `payment-refund.service.ts:602-625`: approve diulang dengan key sama pada rantai 2 level → `IDEMPOTENCY_KEY_REUSED` (`CoreError` tak ditangkap). Fix: cek baris rantai dengan `decisionIdempotencyKey === key && decidedBy === actor` dulu, kembalikan `loadView`.
3. Sedang — `worker-main.ts:195-201`, `payment-refund.service.ts:1044-1056`: panggilan provider berurutan di tick relay outbox (20 × 2×30 dtk) → relay macet ±20 menit, event tenant tertahan. Fix: sweep payout di job/loop sendiri, atau batch kecil + anggaran waktu per tick.
4. Rendah — `:836-843,1013,1027`: polling `pending` menaikkan `payoutAttempts` → 8 poll ≈ 2 jam jadi `MANUAL_RECONCILIATION` palsu. Fix: pisahkan penghitung tunggu provider vs hasil tak diketahui.
5. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit.

## Temuan architect
(menyusul)

## Bukti selesai
Test regresi per temuan; gerbang penuh; reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
