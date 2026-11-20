# 1231 Merge train batch104 (20 Nov)

Peran: merge train. Base `int/batch103`. Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch104" -b int/batch104 int/batch103`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. JANGAN sentuh worktree legend-int-batch102 (perbaikan full run berjalan di sana; hasilnya nanti digabung naik 102→103→104 oleh CTO).

Gabung (`--no-ff`, sudah direview): 1. `ws/1229-tax-export-superseded` (32c16cfe7, mig 0521 sesudah 0519/0520 di batch103; pastikan journal/snapshot urut, `heavy pnpm db:generate` "No schema changes"). 2. `ws/1228-ui-fix-dialogs` (c86d052f1).

Gate: `node scripts/check-migration-redefinitions.mjs --base int/batch103` exit 0; prettier berkas berubah; `heavy pnpm run lint`; `heavy pnpm run typecheck`; `heavy node --test tests/text-contract.test.mjs tests/migration-fk-inline.test.mjs`; `LEGEND_TEST_FILES="src/test/payroll-run-lock-rapel.test.ts src/test/payroll-coretax-a1-export.test.ts src/test/payroll-ptkp-tax-year-1223.test.ts src/test/payroll-run-lock.test.ts" heavy pnpm test`. Konflik non-trivial: satu reviewer sonnet. Commit, push int/batch104, status `docs/briefs/1231-status.md`. Budget 35 tool call; di 28 commit + lapor.
