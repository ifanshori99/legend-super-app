# Brief 89g: tahap A ws12-ai dan ws03-menu (merge train m1)

Aturan: ikuti `89a-merge-prep.md` (termasuk "Wajib: merge asli, bukan squash"). Jangan push, jangan merge ke milestone/m1, jangan pkill/killall, jangan baca .env. Commit lokal, akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tes terarah tanpa heavy: `LEGEND_TEST_FILES="src/test/a.test.ts ..." pnpm test` dari root worktree. Jangan `pnpm check` penuh.

Tahap A saja: JANGAN regen migrasi (nomor migrasi cabang dibiarkan; regen dikerjakan serial nanti). Untuk `apps/api/drizzle/meta/*` ambil sisi m1; file SQL migrasi cabang biarkan ada di disk walau belum di journal.

## A. ws12-ai
- Sumber `ws/ws12-ai` 9f6d680e (berisi katalog `ws/ai-tool-catalog` yang sudah di m1). Worktree `.worktrees/prep-ws12-ai`, cabang `prep/ws12-ai` dari 9f6d680e, `pnpm worktree:setup`.
- `git merge --no-ff milestone/m1` (fb46602d). Selesaikan konflik (union perilaku kedua sisi). Handoff cabang: bagian 'Handoff merge train WS-12' di docs/PROGRESS.md cabang itu.
- `pnpm -s typecheck` (boleh lewat `heavy` bila perlu), `pnpm -s format:check` (prettier --write bila perlu, commit terpisah).

## B. ws03-menu
- Sumber `ws/ws03-menu` d06b163c. Worktree `.worktrees/prep-ws03-menu`, cabang `prep/ws03-menu`, `pnpm worktree:setup`.
- Langkah sama dengan A.

## Laporan
SHA (cek dua parent), file konflik dan cara penyelesaian, hasil typecheck/format, daftar migrasi cabang yang nanti perlu regen.
