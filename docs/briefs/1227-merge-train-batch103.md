# 1227 Merge train batch103 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`). Base `int/batch102` (full run CTO berjalan di `../legend-int-batch102`, JANGAN sentuh worktree itu).

Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch103" -b int/batch103 int/batch102`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup` di worktree itu. Path berisi spasi: kutip.

## Gabung
1. `ws/1223-ptkp-tax-year` (6d791b9ff, sudah LOLOS architect + UI 1226). Migrasinya 0515/0516 bentrok dengan 1217 (0515-0518 di batch102): renumber ke 0519/0520 (`scripts/migration-renumber.mjs`), perbarui `drizzle/meta` (journal + snapshot), referensi test, dan `docs/deployment.md` bila menyebut nomor. `heavy pnpm db:generate` harus "No schema changes" (snapshot basi: bangun ulang 3-arah, jangan tambal migrasi).

## Gate (bukan full run)
- `node scripts/check-migration-redefinitions.mjs --base int/batch102` exit 0.
- prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`.
- `heavy node --test tests/text-contract.test.mjs tests/migration-fk-inline.test.mjs`.
- `LEGEND_TEST_FILES="src/test/payroll-ptkp-tax-year-1223.test.ts <test payroll/A1/lock terkait>" heavy pnpm test`.
- Konflik non-trivial: satu reviewer sonnet atas hunk konflik.
- Commit, push int/batch103. Status `docs/briefs/1227-status.md` di int/batch103.

Budget 40 tool call; di 32 commit + lapor. Lapor: SHA, renumber, konflik, hasil gate.
