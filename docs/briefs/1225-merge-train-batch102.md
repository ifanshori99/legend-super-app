# 1225 Merge train batch102 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`, Retro 54). Base `int/batch101` (full run sedang jalan di `../legend-int-batch101`, JANGAN sentuh worktree itu).

Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch102" -b int/batch102 int/batch101`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: kutip. `command git`.

## Urutan gabung (merge --no-ff, semua sudah LOLOS review)
1. ws/1217-distribusi-reopen (7bf629bc0; migrasi 0515-0518, termasuk UI 1224)
2. ws/1218-manual-reversal-guard (daec573c7)
3. ws/1219-promo-partial-refund (06e48193e)
4. ws/1220-pph21-last-period (d375bc59e)
5. ws/1222-apology-voucher-cap (f05243b73)
JANGAN gabung ws/1223 (belum selesai). Hanya 1217 punya migrasi; nomor tetap 0515-0518.

## Gate (bukan full run; full run oleh CTO)
- `node scripts/check-migration-redefinitions.mjs --base int/batch101` exit 0.
- `heavy pnpm db:generate` "No schema changes".
- prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`.
- `LEGEND_TEST_FILES="tests/text-contract.test.mjs tests/migration-fk-inline.test.mjs tests/ws07-profit-share.test.mjs" heavy pnpm test`.
- Area gate: `node scripts/affected-tests.mjs --base int/batch101 --max 120` lalu `LEGEND_TEST_FILES="<hasil>" heavy pnpm test` dari root.
- Konflik non-trivial: satu reviewer sonnet atas hunk konflik (uang: tanya CTO dulu).
- Commit tiap langkah, push int/batch102. Status singkat `docs/briefs/1225-status.md` di int/batch102.

Budget 50 tool call; di 40 commit + lapor. Lapor: SHA tiap merge, konflik + cara, hasil gate, yang belum.
