# Brief: engineer (Codex) — test penjaga FK terpisah ke tabel FORCE RLS di migrasi baru (legend-1rnql)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/migration-fk-inline-guard .worktrees/migration-fk-inline-guard origin/milestone/m1`.

## Tujuan
Kelas bug "FK ke tabel FORCE RLS ditulis sebagai ALTER TABLE ADD CONSTRAINT terpisah" kena 4 kali (0347, 0348, 0534). Tambahkan `tests/migration-fk-inline.test.mjs` (pola test root lain di `tests/`, dijalankan `scripts/test.mjs`): gagal bila migrasi di `apps/api/drizzle/` yang lebih baru dari nomor patokan menulis FK terpisah untuk tabel yang dibuat di migrasi yang sama; FK terpisah ke tabel lama tanpa `NOT VALID` cukup peringatan (console), bukan gagal. Contoh logika ada di `~/.agents/team/check-journal.mjs` (baca saja, jangan ubah). Migrasi lama yang sudah diterapkan tidak diubah: patokan nomor di atas migrasi terakhir m1 saat ini. Sertakan fixture kecil (SQL contoh di folder test) yang membuktikan test merah pada pola buruk dan hijau pada pola benar.

## Bukti, sebelum melapor
Fixture buruk merah, repo saat ini hijau, `heavy pnpm test` TIDAK dijalankan penuh: jalankan file test itu saja lewat cara yang dipakai `tests/test-discovery.test.mjs` atau `LEGEND_TEST_FILES` bila didukung untuk root test (cek `scripts/test.mjs`). Pra-gate AGENTS.md (prettier, eslint). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/migration-fk-inline-guard` tanpa force. Jangan merge, jangan deploy.
