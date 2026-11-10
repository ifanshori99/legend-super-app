# Brief 92: perbaiki temuan second-opinion Codex pada refund (tingkat K: uang)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`. Fan-out: Explore PRD, implementer per temuan, test-writer, semuanya paralel.

Cabang `ws/refund-approval` (worktree `.worktrees/refund-approval`, SHA 09385266).

## Temuan
1. P1, `apps/api/src/services/payment-refund.service.ts:565`: otorisasi hanya memeriksa `payment.reconcile`. Finance A meminta refund Rp50.000 dan Finance B menyetujuinya; di bawah ambang Rp100.000 payout berjalan tanpa supervisor.
   - Cek dulu aturan approval refund di PRD (`docs/PRD.md`, grep refund/ambang/supervisor).
   - Bila PRD mewajibkan supervisor, wajibkan kewenangan supervisor selain approval sah.
   - Bila PRD memang mengizinkan sesama finance di bawah ambang, jangan ubah. Laporkan dengan kutipan PRD.
2. P1, `payment-refund.service.ts:933`: fund lama dengan `evidence_id=NULL` memakai evidence terbaru. Bila transaksi A dan B sama-sama menghasilkan fund pada intent yang sama, refund fund A terkirim ke transaksi B.
   - Hentikan payout ambigu, wajibkan pemetaan evidence asal sebelum retry.
   - Bila perlu backfill atau constraint, buat migration lewat drizzle-kit. Saat merge akan diregen.

## Bukti selesai
- Test regresi untuk tiap skenario.
- Test refund terdampak lewat `test-runner`.
- `heavy pnpm check` sekali di akhir, jalan di latar.
- Reviewer Opus dan architect paralel atas diff.
- Commit lokal, jangan push, jangan merge.

## Laporan
SHA, keputusan temuan 1 (dengan kutipan PRD), perbaikan, hasil test, jumlah subagent.
