# 1164 Payout recon, guard recurring, reload peran approval (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ghostex/fix-so-approval-waktu` (e1020c77e, SIAP batch96; memuat fix waktu approval 1137+1151). Cabang kerja: `ws/1164-payout-recurring-approval`. Landing sesudah batch96. Tingkat K (uang + akses): architect effort xhigh sebelum lapor.

## Kartu (file terpisah, bisa paralel)
1. `legend-q2nkl` Recon payout: waiter yang kena `lock_timeout` 55P03 melewati operasi. File: `payroll-payout-recon.service.ts`, `db/index.ts` bila perlu. Prasyarat e7d803748 sudah di m1. Test: waiter yang timeout tidak melewatkan recon dan tidak membayar ganda.
2. `legend-ww562` DOIT recurring: cek `DOIT_RECURRING_ENABLED` juga di service (`payment-recurring.service.ts:~118`, `config/env.ts:~268`), bukan hanya di rute (`payment-recurring.routes.ts:34`). Test: flag mati, pemanggil service langsung (job/consumer) ditolak.
3. `legend-k8g62` Platform-approval: muat ulang peran approver sesudah `lockChain`. File: `platform-approval.service.ts` (~:1357). Test: peran dicabut di antara cek awal dan lock -> approval ditolak.

## Batas
- Jangan sentuh: `payroll-payout-gl.service.ts` (kartu UI terpisah), `payment-admin*`, `order-given.ts`, `accounting-journal*`.
- Tanpa migrasi. Bila ternyata perlu: berhenti dan lapor ke CTO untuk nomor.
- SO approval ronde 2 (1160) berjalan atas base ini. Bila CTO mengabari base berubah, `git merge` head baru base.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali, prettier + eslint file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji.
