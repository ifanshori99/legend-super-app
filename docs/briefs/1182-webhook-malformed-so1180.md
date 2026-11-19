# 1182 Fix SO 1180: pemulihan invoice MALFORMED (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: spawn subagent paralel dalam satu giliran (test-writer + implementer, reviewer sesudahnya).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ws/1176-webhook-opname-p3` (4fdcaaec1). Cabang kerja: `ws/1182-webhook-malformed-so1180`. Landing sesudah 1176. Tingkat K (webhook pembayaran): architect effort xhigh sebelum lapor. Tanpa migrasi; bila perlu: berhenti dan lapor ke CTO.

## Kartu
`legend-aj5tv` (baca `bd show`). Temuan, alur, dan usul test: `docs/qa/second-opinion-webhook-opname-1180.md` P1.
Keputusan CTO: pemulihan MALFORMED memakai seluruh row hasil `UPDATE ... RETURNING` (binding integrasi, payload, status, claim) untuk `processStoredEvent`, bukan row lama. Pembayaran sah sesudah pemulihan tercatat tepat sekali; resend sesudahnya duplikat tanpa efek uang kedua.

## Batas
Berkas utama: `apps/api/src/services/payment-webhook.service.ts` dan test webhook-nya. Jangan sentuh: `payment.service.ts`, `reservation-*`, `payment-recurring.service.ts`, `payroll-payout*`, `drizzle/`, `access.service.ts`.

## Bukti selesai
Test gagal-dulu sesuai usul test laporan (terarah lewat `heavy`), test webhook lama tetap hijau, typecheck api lewat `heavy` sekali dengan exit code di laporan, prettier + eslint file berubah. Tunggu job heavy dengan Bash run_in_background (notifikasi exit); jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
