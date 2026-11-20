# 1254 Merge train batch106 (21 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`, Retro 54). Base `milestone/m1` (6f418df53).

Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-int-batch106" -b int/batch106 milestone/m1`, lalu di worktree `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: kutip. `command git`.

## Urutan gabung gelombang A (merge --no-ff, semua sudah direview; tanpa migrasi)
1. `ws/1251-journal-dividend-period` (ce670ccf6)
2. `ws/1243-promo-refund-manual` (a0fdab629)
3. `ws/1245-void-ack-ingest` (4750f4b1a)
4. `ws/1250-gateway-cli` (29d1f4745)
5. `ws/1249-mock-guard-reports` (77126eae3)

Gelombang B (1242, 1244, 1248, 1252, 1253) dikirim CTO lewat pesan sesudah lolos review; gabung dengan urutan yang dikirim. Bila ada migrasi baru: renumber mulai 0523 (`scripts/migration-renumber.mjs`).

## Gate per gelombang (bukan full run; full run oleh CTO)
- `node scripts/check-migration-redefinitions.mjs --base milestone/m1` exit 0 atau tiap LOST dinilai di status.
- `heavy pnpm db:generate` = "No schema changes".
- prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`.
- `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs tests/test-runner-selection.test.mjs tests/web-mock-build-guard.test.mjs tests/ws11-reports-not-ready.test.mjs`.
- Area: `node scripts/affected-tests.mjs --base milestone/m1 --max 120` lalu `LEGEND_TEST_FILES="<hasil>" heavy pnpm test` dari root.
- `heavy pnpm --filter @starter/api build` lalu pastikan `apps/api/dist/set-gateway.js` ada (1250).
- Konflik non-trivial: satu reviewer sonnet atas hunk konflik.
- Commit tiap langkah, push int/batch106. Status singkat `docs/briefs/1254-status.md` di int/batch106.

Budget 50 tool call per gelombang; di 40 commit + lapor. Lapor: SHA tiap merge, konflik + cara, hasil gate, yang belum.
