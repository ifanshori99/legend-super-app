# Brief: second-opinion — adapter DOIT PaymentProvider (legend-b9i)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-provider`, cabang `ws/doit-provider`, SHA `8fed84ef`.
Rentang diff: `git diff $(git merge-base main 8fed84ef)..8fed84ef` (abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `apps/api/src/services/payment-doit.ts`
- `apps/api/src/services/payment-doit-wire.ts`
- `apps/api/src/services/payment-webhook.service.ts`
- `apps/api/src/services/payment-gateway.ts`
- `apps/api/src/services/payment.service.ts`
- `apps/api/src/routes/payment-webhook.routes.ts`
- `apps/api/src/worker/payment-gateway-poll.job.ts`
- `apps/api/src/db/schema/payment-gateway-webhook.ts`
- Migration baru di `apps/api/drizzle` (nomor dirapikan saat merge, bukan temuan)

## Invariant (PRD)
- Webhook Terverifikasi: header `PayBridge-Signature` (HMAC-SHA256) wajib cocok. Dedupe per ID event. Simpan dulu, lalu proses idempoten.
- Urutan kedatangan webhook tidak dijadikan acuan. Status pada payload menjadi sumber kebenaran.
- Siklus Pembayaran: nominal dari server, idempotency key unik. Pembayaran yang lunas setelah kedaluwarsa ditandai untuk tindak lanjut.
- Tagihan Berulang: DOIT tidak menyimpan kartu dan tidak auto-debit.
- Failover: kegagalan gateway tidak boleh membuat transaksi tercatat ganda atau lunas tanpa bukti.
- Isolasi tenant dipaksa: webhook tenant A tidak bisa mengubah transaksi tenant B.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
