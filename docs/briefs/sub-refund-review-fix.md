# Brief: perbaikan review K ws/refund-approval

Worktree: legend/.worktrees/refund-approval (cabang ws/refund-approval, sudah merge main). Jangan baca .env*, jangan pkill.
Kode utama: apps/api/src/services/payment-refund.service.ts (+ payment-admin.service.ts, payment-refund-gateway.ts, worker-main.ts, routes/platform-approval.routes.ts). Test: apps/api/src/test/payment-refund-approval.test.ts.

## Temuan (prioritas)

A. Tinggi — refund admin tidak menolak intent terikat dokumen sumber (orderId, accessTicketId, subscriptionInvoiceId). createRefund & applyApproval wajib tolak intent berdokumen sumber kecuali requester sistem (system:pos, system:reservation). Refund penjualan wajib lewat modul pemilik (order.refunded). Batas refund gabungan payment_refunds + pos_order_refunds di bawah kunci yang sama bila dua jalur tetap mungkin. Refund provider completed atas dana tanpa dokumen sumber: periksa apakah perlu jurnal balik (payment.refunded sengaja tidak memposting di packages/shared/src/accounting/posting-rules.ts:16-18).
B. Sedang — idempotency: approve diulang dengan key sama (rantai 2 level, juga level 1) → IDEMPOTENCY_KEY_REUSED; reject diulang → 409. Fix: cek baris rantai dengan decisionIdempotencyKey===key && decidedBy===actor, kembalikan loadView; reject dibungkus idempotentPaymentAdminWrite. Kontrak docs/plan/contracts.md:118.
C. Sedang — sweep payout di tick relay outbox (worker-main.ts ~195-201, service ~1044-1056) memanggil provider berurutan (20 × 2×30 dtk) → relay macet. Fix: loop/job sendiri atau batch kecil + anggaran waktu ±20 dtk per putaran.
D. Rendah — polling status pending menaikkan payoutAttempts → MANUAL_RECONCILIATION palsu. Pisahkan penghitung tunggu provider vs hasil tak diketahui.
E. Rendah — refund dana belum teralokasi pakai evidence terbaru intent, bukan milik dana. Simpan evidence id di payment_unallocated_funds (payment.service.ts ~1078,1181).
F. Rendah — cek payment.reconcile per outlet hanya di route refund; lewat inbox approval terlewat. Cek tiap decidedBy di settleLocked.

Migration baru digenerate SETELAH semua perubahan schema: `pnpm db:generate --name refund_approval_payout` (dijalankan agent utama, bukan subagent).

## Keputusan desain (engineer)

- A: tolak bila `refund.unallocatedFundId IS NULL` DAN intent punya orderId/accessTicketId/subscriptionInvoiceId DAN requester adalah user (`isUserId`). Requester `system:*` (reservation, pos, qr — lihat systemRefundActorSchema di packages/shared/src/payment/admin.ts) tetap boleh. Dana belum teralokasi (unallocated fund) tetap boleh (bukan bagian penjualan, penerimaannya tidak dijurnal, jadi refund-nya juga tidak dijurnal).
  - createRefund (payment-admin.service.ts): 409 sebelum insert, kode error `REFUND_SOURCE_DOCUMENT` (ikuti pola conflict/CoreError yang ada).
  - applyApproval: refund lama yang terlanjur pending → `failRefund` reason baru `source_document` (tambah ke CHECK di db/schema/payment-admin.ts:197 dan refundFailureReasonSchema di packages/shared/src/payment/admin.ts:193, plus label i18n bila ada).
  - listRefundablePayments: jangan tawarkan intent berdokumen sumber (bila filter sederhana).
- B: di decideRefund, sebelum memutuskan: bila ada baris rantai dengan decisionIdempotencyKey===key && decidedBy===actor → return loadView (replay). Reject replay juga sama. Status non-pending + replay key sama dari actor sama → loadView, bukan 409.
- F: settleLocked: sebelum applyApproval/failRefund dari rantai, `authorize(tx, context, row.decidedBy, "payment.reconcile", refund.outletId)` untuk tiap baris decided approved; gagal → refund tetap pending tidak dibayar (atau failed 'rejected'?) — pilih: lempar AccessError, tidak membayar.
- C: sweep payout keluar dari relay: loop/timer sendiri di worker-main.ts (start/stop ikut shutdown SIGTERM), plus `sweepApprovedRefundPayouts` menerima anggaran waktu (default 20 dtk): berhenti klaim refund baru bila anggaran habis.
- D: kolom baru `payout_pending_polls` integer default 0 NOT NULL CHECK >=0 di payment_refunds. Jawaban provider `pending` tidak menghabiskan payoutAttempts (kembalikan increment klaim), menaikkan payout_pending_polls; backoff polling pending pakai penghitung ini (maks ±1 jam). MANUAL_RECONCILIATION karena pending hanya bila pending > 72 jam sejak decidedAt. payoutAttempts hanya hasil tak diketahui (error/timeout).
- E: kolom baru `evidence_id` uuid nullable (FK ke payment_evidence.id bila pola repo memakai FK) di payment_unallocated_funds; diisi saat insert dana (payment.service.ts ~1146, ~1249; recordPaymentEvidence perlu mengembalikan id). Payout refund dana memakai fund.evidenceId; null (baris lama) → perilaku lama.
- Jangan generate migration. Jangan commit. Jangan jalankan suite penuh; boleh `pnpm --filter @starter/api exec tsc --noEmit` lewat `heavy`.

## Potongan

- P1 (implementer): A + B + F. File: payment-refund.service.ts baris 1–690 (sampai rejectRefund), payment-admin.service.ts, db/schema/payment-admin.ts (CHECK failure_reason saja), packages/shared/src/payment/admin.ts.
- P2 (implementer): E sisi penyimpanan. File: db/schema/payment.ts, payment.service.ts. Tambah `evidenceId` di paymentUnallocatedFunds.
- P3 (implementer, SETELAH P1): C + D + E sisi pembaca. File: payment-refund.service.ts baris 690–akhir, worker-main.ts, db/schema/payment-admin.ts (kolom payout_pending_polls).
- T (test-writer): file baru apps/api/src/test/payment-refund-review-fix.test.ts, pakai helper/fixture dari payment-refund-approval.test.ts & refund-fake-gateway.ts (ekspor helper bila perlu tanpa mengubah perilaku test lama). Satu test regresi per temuan A(createRefund 409 intent orderId; system:pos tetap jalan; refund dana teralokasi tetap jalan), B (approve replay key sama rantai 2 level & level 1; reject replay), C (sweep berhenti saat anggaran habis), D (8+ poll pending tidak jadi MANUAL_RECONCILIATION), E (refund dana pakai evidence milik dana, bukan evidence terbaru intent), F (approver rantai tanpa payment.reconcile di outlet → tidak dibayar).
