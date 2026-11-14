# Brief: engineer (Codex) — flake db-role-provisioning (legend-nagq0)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `milestone/m1`. Cabang akhir: `fix/flake-db-role-snapshot`.

## Tujuan
`tests/db-role-provisioning.test.mjs` test 'legend-zoqc job provisions restricted roles on a fresh database, idempotently' merah di run penuh (2 dari 2 di batch64a), lulus 3x sendirian. Diff: `pg_auth_members` memuat `legend_runtime_<hex>` lain sebagai anggota `legend_app`. Dugaan: `snapshot()` (baris ~100-120) membaca keanggotaan role seluruh klaster dan menangkap role milik test node lain yang berjalan paralel. Buktikan dulu (reproduksi: jalankan test ini bersamaan dengan test yang membuat legend_runtime_*), lalu perbaiki dengan menyaring snapshot ke role milik test itu sendiri. Jangan melemahkan pemeriksaan role milik test ini; `--test-concurrency=1` hanya bila penyaringan tidak mungkin.

## Kartu (agent Codex tidak menjalankan bd)
legend-nagq0 (P2). Terkait legend-3mgje (tertutup).

## Scope
- Boleh: `tests/db-role-provisioning.test.mjs` dan helper test-nya.
- Jangan: skrip provisioning produksi, migrasi, kode aplikasi.

## Bukti selesai
- Reproduksi gagal sebelum fix (catat perintah dan hasil).
- Setelah fix: test lulus 3x sendiri dan lulus saat dijalankan bersamaan dengan test pembuat legend_runtime_* (lewat `heavy`).
- Prettier dan eslint pada file diubah.

## Batas kerja ulang
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Jangan jalankan suite penuh.

## Sebelum melapor
Commit hanya file scope, rename cabang `ghostex/...` ke `fix/flake-db-role-snapshot`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti reproduksi dan fix, file berubah, commit, cabang akhir, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
