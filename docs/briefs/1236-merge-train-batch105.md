# 1236 Merge train batch105 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`, Retro 54). Base `int/batch104` (full run CTO sedang berjalan di `../legend-int-batch104`, JANGAN sentuh worktree itu).

Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch105" -b int/batch105 int/batch104`, lalu di worktree `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: kutip. `command git`.

## Urutan gabung (merge --no-ff, semua LOLOS architect)
1. `ws/1232-neg-stock-reval` (288614f86): migrasi `0522_inventory_gl_postings_source_key`. Cabangnya dari base tanpa 0521: pastikan journal drizzle berurutan 0521 (tax export superseded, sudah di batch104) lalu 0522; snapshot 0522 dibangun ulang 3-arah bila basi (jangan tambal SQL).
2. `ws/1234-refund-room` (60797be12): tanpa migrasi.

## Gate (bukan full run; full run oleh CTO)
- `node scripts/check-migration-redefinitions.mjs --base int/batch104` exit 0 atau tiap LOST dinilai di status.
- `node --test tests/migration-fk-inline.test.mjs`; `heavy pnpm db:generate` = "No schema changes".
- prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`.
- `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs`.
- Area: `node scripts/affected-tests.mjs --base int/batch104 --max 120` lalu `LEGEND_TEST_FILES="<hasil>" heavy pnpm test` dari root. Data-import registry test wajib ikut (migrasi baru).
- Konflik non-trivial: satu reviewer sonnet atas hunk konflik.
- Commit tiap langkah, push int/batch105. Status singkat `docs/briefs/1236-status.md` di int/batch105.

Budget 50 tool call; di 40 commit + lapor. Lapor: SHA tiap merge, konflik + cara, hasil gate, yang belum.
