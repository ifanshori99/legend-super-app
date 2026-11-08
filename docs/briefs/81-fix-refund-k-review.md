# Brief: engineer — perbaikan review K ws/refund-approval (5b6a707)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/refund-approval`, cabang `ws/refund-approval`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Tinggi — `services/payment-refund.service.ts:270-363`: refund provider `completed` hanya kirim `payment.refunded`, yang sengaja tidak memposting (`packages/shared/src/accounting/posting-rules.ts:16-18`); jurnal refund hanya dari `order.refunded` (`pos-order-corrections.ts`). Uang keluar tanpa jurnal balik → GL dan rekonsiliasi gateway selisih. Batas refund juga terpisah: POS refund tidak membaca `payment_refunds`, `refundableBalance` tidak membaca `pos_order_refunds` → satu tagihan bisa dikoreksi dua jalur melebihi bayar. Fix: jurnal balik idempoten per `refundId` saat completed (kirim `order.refunded` atau aturan posting `payment.refunded`), dan batas refund gabungan kedua tabel di bawah kunci yang sama. Test: refund gateway → jurnal balik; POS refund + gateway refund tidak melebihi bayar.
2. Sedang — `payment-refund.service.ts:602-625`: approve diulang dengan key sama pada rantai 2 level → `IDEMPOTENCY_KEY_REUSED` (`CoreError` tak ditangkap). Fix: cek baris rantai dengan `decisionIdempotencyKey === key && decidedBy === actor` dulu, kembalikan `loadView`.
3. Sedang — `worker-main.ts:195-201`, `payment-refund.service.ts:1044-1056`: panggilan provider berurutan di tick relay outbox (20 × 2×30 dtk) → relay macet ±20 menit, event tenant tertahan. Fix: sweep payout di job/loop sendiri, atau batch kecil + anggaran waktu per tick.
4. Rendah — `:836-843,1013,1027`: polling `pending` menaikkan `payoutAttempts` → 8 poll ≈ 2 jam jadi `MANUAL_RECONCILIATION` palsu. Fix: pisahkan penghitung tunggu provider vs hasil tak diketahui.
5. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit.

## Temuan architect (urutan fix: 2, 1, 3, 4; 5–6 boleh bead susulan)
1. Tinggi — `payment-admin.service.ts:288-292`, `payment-refund.service.ts:271-363`: refund admin tidak menolak intent yang terikat dokumen sumber (`orderId`, `accessTicketId`, `subscriptionInvoiceId`) → uang keluar tanpa jurnal balik, poin loyalti tidak batal (LOY-02), dan POS refund bisa jalan lagi (total 2x bayar). Fix: `createRefund` dan `applyApproval` tolak intent berdokumen sumber kecuali requester sistem (`system:pos`, `system:reservation`); refund penjualan wajib lewat modul pemilik (`order.refunded`). Ini pendekatan pilihan untuk temuan 1 reviewer; jurnal balik gateway tetap untuk dana tanpa dokumen sumber bila relevan.
2. Sedang — migration 0063 bentrok: hapus SQL + snapshot, `pnpm db:generate --name refund_approval_payout` (when baru; lihat "Catatan merge milestone" di PROGRESS).
3. Sedang — idempotency (`:510-514`, `:602-623`, kontrak `docs/plan/contracts.md:118`): reject diulang → 409; approve level 1 diulang → `IDEMPOTENCY_KEY_REUSED`. Fix: kembalikan `loadView` bila ada baris rantai dengan key + actor sama; reject langsung dibungkus `idempotentPaymentAdminWrite`.
4. Sedang — sama dengan temuan 3 reviewer (sweep payout di relay; batasi ±20 dtk per putaran atau loop sendiri).
5. Rendah — `:820-835`: refund dana belum teralokasi pakai evidence terbaru intent, bukan milik dana. Fix: simpan evidence id di `payment_unallocated_funds` (`payment.service.ts:1078,1181`).
6. Rendah — `:507`, `routes/platform-approval.routes.ts:93`: cek `payment.reconcile` per outlet hanya di route refund; lewat inbox approval terlewat. Fix: cek tiap `decidedBy` di `settleLocked`.

## Bukti selesai
Test regresi per temuan; gerbang penuh; reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
