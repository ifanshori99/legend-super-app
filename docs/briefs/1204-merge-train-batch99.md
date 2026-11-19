# 1204 Merge train batch99 (20 Nov)

Peran: merge train (`~/.agents/team/roles/merge-train.md`). Tanpa Ghostex/Codex: semua lewat Claude Code.

## Base dan worktree
- Base: `int/batch98` (tip saat mulai; batch98 belum mendarat di m1, full run sedang jalan di `../legend-int-batch98` — JANGAN sentuh worktree itu).
- Buat: `git worktree add "../legend-int-batch99" -b int/batch99 int/batch98`, lalu di worktree itu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: selalu kutip.

## Urutan gabung
1. ws/1191-refund-hold-hardening: base-nya int/batch97 lama yang memuat 1172 (bug). Cherry-pick SATU commit saja: `48da44a3f`. Jangan merge cabangnya.
2. ws/1192-payout-hold-release `9174668d0` (base ws/1179, sudah ada di batch98). Migrasi 0710-0712 -> renumber 0509-0511 (SQL, journal idx/tag, snapshot id/prevId, registry/referensi test yang menyebut nomor).
3. ghostex/26e97de4 `b15c3ac85` (kartu 1201, akses jam DB; tanpa migrasi). Menggantikan ws/1172 + ghostex/1183: jangan bawa keduanya.
4. ws/1199-edge-catalog-so1197: TUNGGU pesan CTO (belum SIAP). Jangan gabung sebelum diberi tahu.

## Pelajaran batch98 (wajib)
Snapshot drizzle dari cabang bisa basi (dibuat sebelum tabel m1). SQL boleh benar tapi `pnpm db:generate` tidak kosong. Sesudah rechain: `heavy pnpm db:generate` HARUS "No schema changes". Bila tidak kosong dan SQL memang lengkap: bangun ulang snapshot dengan merge 3-arah (snapshot base int + delta snapshot cabang N-1 -> N), contoh skrip: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend/1c59368e-c46f-4b0c-abae-9d9e3b0f8b19/scratchpad/rebuild.mjs`. Jangan menambal dengan migrasi baru. Bila SQL kurang: berhenti, lapor.

## Gate sebelum lapor (bukan full run; full run dijalankan CTO sesudah batch98 mendarat)
- `node scripts/check-workspace-links.mjs` bila ada, prettier --check berkas berubah, `heavy pnpm run lint`, `heavy pnpm run typecheck` (bisa antre di belakang full run batch98, tidak apa).
- `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs`.
- `heavy pnpm db:generate` kosong.
- Test terarah berkas yang konflik/ter-renumber: `LEGEND_TEST_FILES="..." heavy pnpm test`.
- Reviewer sonnet atas hunk konflik + rechain bila ada konflik non-trivial.
- Commit tiap langkah di int/batch99 (lokal; push boleh). Tulis status singkat `docs/briefs/1204-status.md` di int/batch99.

## Lapor
SHA tiap langkah, peta renumber, konflik + cara selesai, hasil gate, yang belum.
