# 1215 Merge train batch101 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`, termasuk Retro 54). Base `int/batch100` (belum mendarat; full run berjalan di `../legend-int-batch100`, JANGAN sentuh worktree itu).

Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch101" -b int/batch101 int/batch100`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup` di worktree itu. Path berisi spasi: kutip. `command git`.

## Urutan gabung (merge --no-ff, semua sudah direview)
1. ws/1207-workflow-tooling (tooling, tanpa kode produksi)
2. ws/1209-hardening-deploy (env + Caddyfile + docs)
3. ws/1210-profit-share-failclosed
4. ws/1213-payroll-overlap
5. ws/1212-edge-promo-rewind
6. ws/1211-inventory-count-late (466a8da10)
JANGAN gabung ws/1214 (belum selesai).

Migrasi baru (bila ada) direnumber ke nomor berikut sesudah migrasi terakhir di int/batch100 (`scripts/migration-renumber.mjs`), `heavy pnpm db:generate` harus "No schema changes" (snapshot basi: bangun ulang 3-arah, jangan tambal migrasi).

## Gate (bukan full run; full run oleh CTO)
- `node scripts/check-migration-redefinitions.mjs --base int/batch100` (dari 1207) exit 0 atau tiap LOST dinilai: tulis penilaian di status.
- prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`.
- `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs`.
- Area gate: `node scripts/affected-tests.mjs --base int/batch100 --max 120` lalu `LEGEND_TEST_FILES="<hasil>" heavy pnpm test` dari root.
- Konflik non-trivial: satu reviewer sonnet atas hunk konflik.
- Commit tiap langkah, push int/batch101. Status singkat `docs/briefs/1215-status.md` di int/batch101.

Budget 50 tool call; di 40 commit + lapor. Lapor: SHA tiap merge, renumber, konflik + cara, hasil gate, yang belum.
