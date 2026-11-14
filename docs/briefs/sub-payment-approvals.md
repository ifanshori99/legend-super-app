# Sub-brief: payment approvals (legend-hcqs, legend-m0k)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-3fed8723` (base origin/milestone/m1). Tingkat K (uang + akses).
Aturan: jangan sampai rugi. Bila ragu, aturan paling membatasi. Jangan sentuh jurnal GL otomatis, loyalty/referral, payroll.
Migrasi hanya nomor 0357-0567 (bila perlu). Test: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree; satu runner heavy per thread (test-writer/test-runner yang ditunjuk saja).

## Fakta awal (CTO/engineer)

- Refund lewat approval_requests sudah ada: `apps/api/src/services/payment-refund.service.ts` (`openRefundChainAtRequest`, `handleRefundApprovalResolved` ~:2039), test `apps/api/src/test/payment-refund-approval.test.ts`.
- Unallocated (PAY-04): `apps/api/src/services/payment-admin-funds.service.ts` `resolveUnallocatedFund` membuka refund pending + `openRefundChainAtRequest`. Perlu dibuktikan: fund tak bisa dicairkan dua kali, refund tak dieksekusi tanpa approval disetujui, ditolak/kedaluwarsa tak eksekusi, pengaju tak bisa setujui sendiri, approval tenant lain ditolak, dan `fund.resolution` di-set saat (hanya saat) refund disetujui/selesai.
- Rekonsiliasi: `apps/api/src/services/payment-admin-reconciliation.service.ts` `resolveReconciliationCase` langsung set status `resolved` TANPA approval. Celah utama.

## A. Explore: refund approval

Petakan `openRefundChainAtRequest`, `handleRefundApprovalResolved`, cara approval_requests dibuat (action_type, ref, requester, expiry), cara consumer terdaftar (pola `*-approval-consumers.ts`, `platform-approval.service.ts`), aturan requester != approver, cek tenant, expiry. Laporkan apakah unallocated fund `resolution` di-set saat refund approved/completed dan di mana; celah di alur unallocated.

## B. Explore: rekonsiliasi + action_type

Petakan schema `payment_reconciliation_cases` (kolom status, resolvedBy, note), rute + validator shared (`packages/shared`), web `apps/web/src/features/payment*` (view refund admin: apakah `approvalRequestId`/`approvedBy` tampil; view case), daftar action_type approval (enum DB atau string? perlu migrasi?), katalog event/izin/label root (`tests/*-contract.test.mjs`, `text-contract`), `data-import-registry.test.ts`. Usulkan desain minimal: resolve case -> buat approval_request pending (status case `pending_approval`?) -> consumer saat approved menutup case; rejected/expired tidak.

## C. Explore: m0k EDC standalone

Audit `apps/api/src/services/pos-edc-standalone.ts`, `pos-edc-tender.ts`, `pos-order-payment.ts`, `routes/pos-order.routes.ts`, edge `edc/agent.ts`, device PIN/supervisor override (`legend-dxb`). Pertanyaan: apakah mode standalone EDC WAJIB PIN supervisor diverifikasi di server (bukan klien), requester != approver, PIN salah/terkunci ditolak, tenant/outlet scope? Beri bukti file:baris dan test yang sudah membuktikan (mis. `pos-edc-standalone.test.ts`, `device-pin-service.test.ts`). Celah: jelaskan tepat.

## D. test-writer: gagal-dulu

File baru `apps/api/src/test/payment-unallocated-approval.test.ts` (pakai helper/fixture seperti `payment-refund-approval.test.ts` dan `payment-admin-api.test.ts`): kasus unallocated di bagian Fakta awal. Lalu `apps/api/src/test/payment-reconciliation-approval.test.ts`: resolve case tidak menutup case langsung tetapi membuat approval_request pending; approve oleh orang lain menutup case (resolvedBy = pengaju? approvedBy tercatat); self-approve ditolak; reject/expire membiarkan case open; tenant lain tak bisa lihat/putuskan; resolve kedua saat pending -> 409. Ikuti kontrak yang diputuskan engineer bila sudah ada di bagian E. Jalankan terhadap base, catat mana merah (merah karena sebab benar).

## E. Kontrak (diputuskan engineer, 14 Nov)

Rekonsiliasi lewat approval_requests. Aturan paling membatasi: tidak ada jalan menutup case tanpa chain yang disetujui orang lain.

1. action_type baru `reconciliation_case` di `APPROVAL_ACTIONS` (`packages/shared/src/access/approval.ts`, PRD "PAY recon / §3.7"), plus `DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES` meniru `DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES` (floor 0, level 1, dua baris: role template Owner dan Finance, salah satu cukup, distinct actor). Tidak masuk `SELF_APPROVABLE_ACTION_TYPES`. Label i18n (`i18n/messages/access.ts`, `ws01-approvals.ts`), peran web `apps/web/src/features/ws01-approvals/logic.ts`. Seed tenant baru di `seedTenantRoleTemplates` (ikut pola shareholder_version).
2. Migrasi `apps/api/drizzle/0357_reconciliation_case_approval.sql` (+ meta journal/snapshot lewat `pnpm db:generate` lalu tambah SQL custom): CHECK status jadi `open|pending_approval|resolved`; kolom nullable `approval_chain_id` (tipe sama dengan payment_refunds.approval_chain_id), `requested_by`, `approved_by` (tipe sama dengan resolved_by). Seed policy `reconciliation_case` (dua baris, owner dan finance) untuk tiap tenant ber-role template tersebut; tenant tanpa salah satu tetap dapat baris yang ada (pola 0241, NO FORCE/FORCE RLS). Tidak ada `ADD CONSTRAINT` untuk tabel baru. Akui di `data-import-registry.test.ts` bila tes itu menuntut.
3. `resolveReconciliationCase` (endpoint lama, body `note`): case `open` -> `openApprovalRequest({sourceModule:"payment", actionType:"reconciliation_case", objectType:"payment_reconciliation_case", objectId: caseId, amountIdr: abs(variance), outletId, requestedBy: actor, source:"user", requestReason: note, deadlineMinutes: 10080, idempotencyKey})`. `required:false` -> 409 (jangan tutup). `APPROVAL_POLICY_MISSING` -> biarkan error naik, case tetap open (JANGAN ditelan seperti refund). Sukses: status `pending_approval`, approval_chain_id, requested_by=actor, note; audit `payment.reconciliation_case_resolution_requested`; balikan DTO case. Case `pending_approval` atau `resolved` -> 409.
4. Consumer `handleReconciliationApprovalResolved(context, event, now)` di `apps/api/src/services/payment-reconciliation-approval-consumer.ts` (pola `profit-share-approval-consumers.ts`: cek name, sourceModule "payment", objectType, tenant; event bukan otoritas), daftarkan di `worker-main.ts`. `settleReconciliationCaseForApproval(tx, context, caseId|chainId, now)`: lock case FOR UPDATE, harus status pending_approval dan chain id sama, `resolveApprovalChainOutcome`: pending -> no-op; approved -> status resolved, resolvedBy=requested_by, approvedBy=penyetuju akhir (dari DB), resolvedAt=now, audit `payment.reconciliation_case_resolved` + event lama `reconciliation_case.resolved`; rejected/expired -> status open, approval_chain_id null, audit `payment.reconciliation_case_resolution_rejected`/`_expired`. Replay idempotent.
5. DTO case (`packages/shared/src/payment/admin.ts`): status enum + `approvalRequestId: string|null`, `requestedBy`, `approvedBy` (string|null). DTO refund admin: tambah `approvalRequestId` (dari approval_chain_id) bila belum ada; `approvedBy` sudah ada sebagai nama? ikuti yang ada.
6. Web `apps/web/src/features/ws05-payment-admin/`: panel rekonsiliasi tampilkan status "Menunggu persetujuan" + approvalRequestId/approvedBy; dialog refund tampilkan approvalRequestId. Teks lewat katalog i18n yang ada.

## G. implementer API

Bagian E butir 2, 3, 4 (+ seedTenantRoleTemplates dari butir 1). File: drizzle 0357 + meta, `db/schema/payment-admin.ts`, `payment-admin-reconciliation.service.ts`, consumer baru, `worker-main.ts`, service seed role template. Jangan jalankan vitest/tsc (token heavy dipegang test-writer); `pnpm db:generate` boleh.

## H. implementer shared + web

Bagian E butir 1 (kecuali seedTenantRoleTemplates), 5, 6, plus mapping DTO refund di service admin refund bila perlu. Jangan sentuh file bagian G. Jangan jalankan vitest/tsc.

## F. Explore: API approval inti (untuk kontrak rekonsiliasi)

Di `apps/api/src/services/platform-approval.service.ts` dan pemakainya: tanda tangan `openApprovalRequest` (input wajib, nilai balik chainId), arti `APPROVAL_POLICY_MISSING` (tenant tanpa policy untuk action_type: apa yang terjadi, siapa boleh menyetujui; contoh penanganan refund `payment-refund.service.ts:1013-1017,1480-1500`), apakah chain kedaluwarsa memancarkan `approval.resolved` (outcome apa) dan oleh worker apa, di mana requester==approver ditolak, bagaimana decide endpoint mengecek tenant + izin approver. Pola settle consumer: `profit-share-approval-consumers.ts` + `settle*ForApproval` (re-read chain di bawah lock). Seed policy default per action_type (migrasi mana, mis. 0145) dan apakah `unallocated_funds` punya policy/pemakai. Katalog yang wajib diperbarui saat menambah action_type baru (label teks `packages/shared`, `tests/*-contract.test.mjs`, web label). Laporan ringkas file:baris.

## I. Perbaikan temuan architect (jangan jalankan vitest/tsc; satu test-runner nanti)

1. `apps/api/src/test/data-import-registry.test.ts`: daftarkan `0357_reconciliation_case_approval.sql` di `MIGRATION_DATA_STATEMENTS` (meniru entri 0241).
2. `apps/api/src/services/payment-settlement-import.service.ts:431,460`: cek kasus ganda pakai `status IN ('open','pending_approval')`, bukan `= 'open'`. Test gagal-dulu di `apps/api/src/test/payment-settlement-import.test.ts`: impor A -> minta tutup (pending_approval) -> impor B periode tumpang tindih ref lain -> tidak ada kasus baru untuk penjualan yang sama.
3. `apps/api/src/services/payment-admin-reconciliation.service.ts:192,194`: ringkasan hitung `status <> 'resolved'` (open + pending_approval) untuk openCases dan varianceIdr. Test di `apps/api/src/test/payment-reconciliation-approval.test.ts` (kasus baru: ringkasan tetap menghitung kasus pending_approval).
4. Test seed baru `apps/api/src/test/reconciliation-case-policy-seed.test.ts` meniru `shareholder-version-policy-seed.test.ts`: tenant baru dapat policy reconciliation_case, SQL 0357 aman diulang, tenant yang sudah punya policy tidak disentuh.
