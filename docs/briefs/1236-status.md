# 1236 Status merge train batch105 (20 Nov)

Base int/batch104 (64f002066). Cabang int/batch105.

## Merge
1. ws/1232-neg-stock-reval -> 0910ce277. Konflik hanya `apps/api/drizzle/meta/_journal.json` (0521 vs 0522): dua entri disimpan berurutan. Snapshot 0522 basi (prevId = id 0520): dibangun ulang 3-arah (0521 + delta unique constraint 0522, perubahan terpisah), prevId = id 0521. SQL tidak diubah.
2. ws/1234-refund-room -> 5f9b364b7. Bersih, tanpa migrasi.

## Gate
- check-migration-redefinitions --base int/batch104: ok (1 migrasi baru).
- tests/migration-fk-inline.test.mjs: 5/5 lulus.
- BELUM: db:generate, prettier, lint, typecheck, contract tests, area tests. Penyebab: `heavy pnpm worktree:setup` antre di slot 1 (dipakai `pnpm test` milik full run batch104); node_modules belum ada.
