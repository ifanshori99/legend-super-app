# Brief 89d: prep ws-09-ws dan ws09-wifi (merge train m1)

Ikuti `docs/briefs/89a-merge-prep.md` dan `89b-migration-regen.md`. Jangan push, jangan merge ke milestone/m1, jangan pkill/killall, jangan baca .env. Commit lokal, pesan diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tes terarah tanpa heavy: `LEGEND_TEST_FILES="src/test/a.test.ts ..." pnpm test` dari root worktree. Jangan jalankan `pnpm check` penuh (merge train yang menjalankan gate).

## Langkah 1: ws-09-ws
- Worktree `.worktrees/prep-ws-09-ws`, cabang `prep/ws-09-ws`. Merge `prep2/pos-receipt` 39296fae sedang berjalan dengan konflik di `apps/api/src/middleware/public-rate-limit.ts` dan `apps/api/src/worker-main.ts`.
- Selesaikan konflik dengan mempertahankan perilaku kedua sisi (union). Baca `git log` kedua sisi untuk file itu bila ragu.
- Jalankan `pnpm worktree:setup` bila node_modules belum ada. Lalu `pnpm -s typecheck` dan tes terarah untuk file yang disentuh konflik serta tes facility/ws-09 (cari `src/test/*facilit*`, `*public-rate*`, `*worker*`). `pnpm -s format:check` bersih.
- Commit merge.

## Langkah 2: ws09-wifi
- Cabang sumber `ws/ws09-wifi` b9d7e40b (di atas ws/ws-09-ws). Buat worktree `.worktrees/prep-ws09-wifi`, cabang `prep/ws09-wifi` dari b9d7e40b, `pnpm worktree:setup`.
- Merge `prep/ws-09-ws` (hasil langkah 1). Untuk `apps/api/drizzle/meta/*` ambil sisi prep.
- Regen migrasi cabang 0099/0100 milik wifi (bentrok dengan ws02 0099/0100 dan receipt 0101/0102): hapus SQL wifi, `pnpm db:generate` di apps/api (nomor berikutnya setelah 0102, `when` lebih besar), SQL custom/RLS ke file `drizzle-kit generate --custom`. FK ke tabel FORCE RLS: pola 0065/0068 (`NO FORCE` sebelum FK, `FORCE` sesudah). Perbaiki referensi nama migrasi lama di tes.
- Verifikasi typecheck, tes terarah wifi (`src/test/*wifi*`), format:check. Commit.

## Laporan
SHA tiap langkah, cara konflik diselesaikan, nama migrasi baru + `when`, hasil tes, yang belum diverifikasi.
