# Brief: second-opinion — refund approval + provider payout (ws/refund-approval 5b6a707) — PRIORITAS

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-approval`, cabang `ws/refund-approval` (commit `5b6a707`). Dokumen asal: `docs/briefs/51-engineer-refund-approval.md` dan `docs/briefs/sub-refund-approval.md` (keduanya di worktree). Berkas utama:
- `apps/api/src/services/payment-refund.service.ts` (approve/reject, settle, payout, sweep, `applyRefundProviderUpdate`)
- `apps/api/src/services/payment-refund-gateway.ts` (port `PaymentRefundPort`)
- `apps/api/src/services/payment-admin.service.ts` dan `payment-admin-funds.service.ts` (cap, reservasi, lock order)
- `apps/api/src/services/platform-approval.service.ts` (`openApprovalRequest`, `getApprovalChainOutcome`, `decideApprovalRequest`)
- `apps/api/src/worker-main.ts` (wiring consumer dan sweep)
- `apps/api/src/db/schema/payment-admin.ts`, migration `apps/api/drizzle/0063_refund_approval_payout.sql` (belum di-commit, bisa di-regenerate)
- Test: `apps/api/src/test/payment-refund-approval.test.ts`

Konteks keputusan: `docs/PROGRESS.md` di worktree. Jangan baca `.env*` atau `~/.ssh`.

## Fokus (area uang dan auth, wajib diverifikasi)
1. **Approval chain via `approval_requests`.** Requester ≠ approver (`APPROVER_IS_REQUESTER`). Chain sekali pakai, terikat ke refund dan amount (`assertChainBound`), unik per tenant lewat `approval_chain_id`. Cek: chain lama tidak bisa dipakai untuk refund lain atau nominal lain. Cek matriks multi-level: butuh approver berbeda per level, urutan dijaga.
2. **Refund dari system actor** (`system:reservation`, dan `system:pos` bila sudah merge). Requester bukan uuid: orang pertama yang submit jadi requester chain; approve oleh submitter yang sama harus 403; reject oleh manusia lain boleh langsung `failed`/`rejected`. Cek tidak ada jalur di mana satu orang submit lalu approve sendiri.
3. **Isolasi tenant dan outlet.** Setiap query filter tenant; `authorize(..., "payment.reconcile", refund.outletId)`. Approver dari outlet lain atau tenant lain harus ditolak (404/403). Cek `viewerCanApprove` tidak memberi `true` untuk viewer yang tidak berhak.
4. **Cap dicek ulang di bawah lock payment** (`cap_exceeded`). Saat `approved`, cap diperiksa ulang dengan lock intent. Cek: dua refund bersamaan tidak bisa melewati cap; refund yang gagal cap berakhir `failed` dengan audit, bukan stuck `pending`/`approved`.
5. **Payout lewat `PaymentRefundPort`.**
   - Tidak ada panggilan provider di dalam transaksi DB.
   - Claim lease (`payout_claimed_until`, 120 detik) + token (`payout_claim_token`). Record step hanya menulis bila token cocok.
   - Timeout 30 detik per panggilan, timeout = outcome tidak diketahui.
   - Idempotency key `refund:<id>`.
   - Status check (`getRefundStatus`) sebelum kirim ulang bila `payoutAttempts > 0` atau `providerRef` sudah ada.
   - Hanya `succeeded` yang jadi `completed`. Hanya `failed` (decline pasti) yang jadi `failed`/`provider_declined`. Throw tidak pernah mengubah ke `failed`.
   - Late `succeeded` untuk refund yang sudah `failed`: tidak ada tulis status, tapi audit `payment.refund_provider_conflict` dan log error berisi id saja.
6. **`applyRefundProviderUpdate` dan konflik reference.** Lookup by `providerRef` harus tepat satu baris. Jika refund sudah punya `providerRef` berbeda, tolak tanpa tulis. Cek amount mismatch ditolak. Replay state terminal = no-op; kontradiksi terminal = tolak tanpa tulis. Cek indeks unik `(tenant_id, provider_ref)` tidak bisa dilanggar diam-diam.
7. **Worker sweep.** `sweepApprovedRefundPayouts`: backoff `least(2^attempts, 60)` menit, berhenti di 8 attempt, lalu `last_payout_error = 'MANUAL_RECONCILIATION'` dan log error. Cek: backoff memakai `updated_at`, dan claim juga mengubah `updated_at`. Apakah ini menyebabkan retry lebih cepat atau lebih lambat dari yang dimaksud? Cek sweep tidak mengambil baris yang lease-nya masih hidup. Cek sweep tidak membakar attempt untuk baris yang sebenarnya belum waktunya.
8. **Lock order dan deadlock.** Urutan global: payment intent → unallocated fund → refund. Cek `lockRefundGraph`, `resolveUnallocatedFund` (E2 mengubah untuk lock intent dulu), `decideRefund`, `settle`, claim tx, record tx, sweep, dan `applyRefundProviderUpdate`. Cari jalur yang kunci refund dulu lalu intent. Cari juga jalur `FOR UPDATE` di `payment.service.ts` yang bisa bertabrakan dengan refund.
9. **Migration 0063 clash dengan DOIT.** `0063_refund_approval_payout.sql` ada di worktree ini. Cek nomor migration yang dipakai cabang DOIT (`ws/doit-provider`, belum merge) dan cabang lain yang menyentuh `apps/api/drizzle`. Cek SQL: check constraint `failure_reason` (termasuk `cap_exceeded`), unique index `payment_refunds_approval_chain_uq`, unique partial index provider_ref, kolom baru dengan default aman untuk data lama. Tandai migration yang tidak bisa dibatalkan. Rencana rename nomor saat merge dicatat, bukan temuan.
10. **Port dan fake.** `PaymentGatewayPort` tidak boleh diubah (akan merusak fake dan DOIT). Port baru `PaymentRefundPort` harus fail closed (`unconfiguredRefundGateway` melempar `SERVICE_UNAVAILABLE`).

## Test
- Cek test benar-benar membuktikan klaim: dua approval bersamaan (satu eksekusi provider), replay, throw lalu retry, decline, timeout, status check sebelum resend, cap bersamaan, tenant isolation, system requester.
- Test race harus memakai dua transaksi DB nyata, bukan mock urutan saja.
- Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya. Output test panjang lewat subagent `test-runner`. Berat lewat `heavy`.
- Catat test yang belum dijalankan. Jangan klaim lulus tanpa bukti.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. Tandai tiap fokus 1–10: tertutup, belum, atau tidak bisa diverifikasi. "Tidak ada blocker" bila memang tidak ada.
