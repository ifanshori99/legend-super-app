# Brief: second-opinion (Codex, xhigh) — persetujuan pembayaran WS-05

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Jangan jalankan `bd`. Tidak mengubah file.

## Repo dan diff
`/Users/ifanshori99/Projects/legend super app/legend`. Rentang: `git diff milestone/m1...origin/ws/payment-approvals` (d16dfb45b). Sudah direview architect Claude xhigh.

Berkas (hanya ini):
- `apps/api/drizzle/0565_reconciliation_case_approval.sql`
- `apps/api/src/services/payment-reconciliation-approval-consumer.ts`, `payment-settlement-import.service.ts`, `payment-admin.service.ts`, service rekonsiliasi lain yang berubah (`git diff --stat`)
- `apps/api/src/services/access.service.ts`, `packages/shared/src/access/approval.ts`
- alur refund dana tak teralokasi yang ada (`payment-refund.service.ts` `handleRefundApprovalResolved`) hanya sebagai pembanding
Bagi ke subagent Codex maks 3: (1) migrasi + seed policy, (2) consumer approval + status kasus, (3) impor settlement + dana tak teralokasi.

## Invariant (outlet tidak boleh rugi)
- Kasus rekonsiliasi hanya tertutup setelah approval disetujui orang selain pengaju yang masih punya izin `payment.reconcile` di outlet; ditolak/kedaluwarsa membuka kembali.
- Selisih yang sama tidak bisa dihapusbukukan dua kali (impor settlement berulang, konkuren, retry consumer).
- Dana tak teralokasi tidak bisa dicairkan dua kali atau tanpa approval; isolasi tenant.
- Tanpa policy `reconciliation_case`: kasus tidak bisa ditutup.
- Diketahui (jangan dilaporkan ulang): legend-wghbj (user tak berwenang bisa membuat refund tak teralokasi jadi failed).

## Laporan
Satu baris per temuan: `path:baris`, tingkat (P1/P2/P3), masalah, skenario gagal konkret, saran. Tanpa temuan: satu baris.
