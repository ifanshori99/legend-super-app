# 1206 Merge train batch100 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`). Semua lewat Claude Code.

- Base: `int/batch99` (tip ea2aec38b; belum mendarat, full run menyusul). Jangan sentuh `../legend-int-batch98` dan `../legend-int-batch99`.
- Worktree: `command git worktree add "../legend-int-batch100" -b int/batch100 int/batch99`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Kutip path.
- Gabung: `ws/1203-tukar-poin-backend` tip 059d155fa (memuat ws/1165-member-tukar-poin-ui 748364714). Architect xhigh 1203: bersih.
- Migrasi 0733 (when 1795000000110) -> renumber ke nomor berikut sesudah 0511 lewat `scripts/migration-renumber.mjs` (SQL, journal idx/tag/when > 0511, snapshot id/prevId, registry/referensi test). Tanpa renumber drizzle melewatkannya diam-diam.
- Pelajaran snapshot: sesudah rechain `heavy pnpm db:generate` HARUS "No schema changes"; bila tidak dan SQL lengkap, bangun ulang snapshot 3-arah (contoh `docs/briefs/1204-merge-train-batch99.md`). Jangan tambal dengan migrasi baru.
- Gate: prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck`, `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs`, db:generate kosong, `LEGEND_TEST_FILES="src/test/member-points-redeem-1203.test.ts <test pos-points/void/1165 yang ada>" heavy pnpm test`. Reviewer konflik non-trivial: lapor hunk ke CTO.
- Commit tiap langkah, push. Status di `docs/briefs/1206-status.md` di int/batch100. Lapor SHA, peta renumber, konflik, gate.
