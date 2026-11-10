# Brief 137: engineer — konvensi FK migrasi ke tabel FORCE RLS (legend-m007)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (migrasi): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/migration-fk-rls -b ws/migration-fk-rls milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-m007`. Migrasi yang menambah FOREIGN KEY ke tabel yang sudah FORCE tenant RLS (employees, positions, stations, outlets, ...) gagal saat pemilik migrasi bukan superuser: scan FK awal berjalan di bawah `tenant_isolation` dan `app.require_tenant_id()` melempar `tenant context is required`. Production menjalankan migrasi sebagai non-superuser, jadi ini penghalang rilis.
1. Putuskan konvensi repo yang aman untuk production (pilihan: FK `NOT VALID` untuk tabel baru yang kosong, lalu `VALIDATE` dengan cara yang lolos RLS; atau helper migrasi). Pertimbangkan tabel yang sudah berisi data, bukan hanya tabel baru.
2. Tulis konvensinya di `docs/plan/contracts.md`, dengan contoh SQL.
3. Tambah pemeriksaan otomatis (test) yang menjalankan semua migrasi sebagai non-superuser dari nol, supaya pelanggaran berikutnya ketahuan. Pakai pola `edge-received-events-migration.test.ts`.
4. Daftar migrasi yang sudah ada yang melanggar (bila ada) dan cabang yang sedang berjalan yang akan kena (misalnya `ws/hris-leave` 0063). Jangan menulis ulang migrasi yang sudah diterapkan; perbaikan lewat migrasi baru bila perlu.
Di awal: `ghostex board associate legend-m007`, `bd update legend-m007 --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: `docs/plan/contracts.md`, test migrasi baru di `apps/api/src/test/`, helper migrasi baru, migrasi baru hanya bila memang perlu (laporkan nomornya).
- Jangan: migrasi lama yang sudah diterapkan, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
`LEGEND_TEST_FILES="<test migrasi baru> src/test/edge-received-events-migration.test.ts" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong. Commit lokal di `ws/migration-fk-rls`, jangan push. Tulis `docs/briefs/138-second-opinion-migration-fk-rls.md` di folder proyek (jangan commit): rentang diff, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, konvensi yang dipilih dan alasannya, migrasi yang melanggar, cabang yang akan kena, hasil gate, temuan review K.
