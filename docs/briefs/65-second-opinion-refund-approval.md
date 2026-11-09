# Brief: second-opinion — refund approval dan payout provider (ws/refund-approval)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-approval`, cabang `ws/refund-approval` 7c24b7b8, digabung ke `milestone/m1` lewat `prep/refund-approval` SHA `55084e9c` (merge m1 `1056e208`, migration diregen jadi 0079).
Rentang diff: `git diff e4938167 1056e208` (isi cabang saja di atas m1; abaikan drizzle `meta/*.json`). Jangan pakai `merge-base main`: menyeret isi m1 lain.

## Berkas berisiko
- `apps/api/src/services/payment-refund.service.ts`
- `apps/api/src/services/payment-refund-gateway.ts`
- `apps/api/src/services/payment-admin.service.ts`
- `apps/api/src/services/payment-admin-funds.service.ts`
- `apps/api/src/services/platform-approval.service.ts`
- `apps/api/src/worker-main.ts`
- `apps/api/src/db/schema/payment-admin.ts`
- `apps/api/drizzle/0063_refund_approval_payout.sql`

## Invariant (PRD)
- Matriks Approval: penyetuju selalu berbeda dari pemohon.
- ORD-09 dan Override Supervisor: refund manual hanya oleh supervisor, dengan approval dan alasan tertulis.
- POS-02: refund tidak bisa tanpa approval yang sah dan selalu tercatat.
- Siklus Pembayaran: status `pending` → `paid` / `expired` / `failed` → `refunded`. Nominal dari server.
- D39: refund setelah item gagal hanya manual oleh supervisor dengan approval.
- Isolasi tenant dan outlet dipaksa di setiap query dan setiap otorisasi.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.

Putaran fix (brief 92): cabang ws/refund-approval 7c24b7b8, digabung m1 `baf6d615` lewat prep2/refund-approval f5025cf9. Rentang diff fix: `git diff 30a31a3c baf6d615`.
