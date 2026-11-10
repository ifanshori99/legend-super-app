# Brief 148: engineer kecil — pagar data sintetis di setiap jalur impor (legend-v4ld)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Tingkat S; bila menemukan jalur yang bisa menulis data production dari lingkungan non-production, perlakukan sebagai K (`reviewer` Opus).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/data-import-guard -b ws/data-import-guard milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-v4ld`. Petakan semua jalur impor/seed/backfill yang menulis data (impor CSV menu/karyawan/stok, impor settlement, seed dev, `pnpm db:*` backfill, skrip `apps/api/src/db/*`). Pasang `assertDataImportAllowed` di tiap batas sebelum menulis, dengan sumber yang diklasifikasikan eksplisit, sehingga data sintetis tidak bisa masuk production dan data production tidak bisa ditulis dari lingkungan non-production. Tambah test yang gagal bila jalur impor baru tidak memanggil pagar (pemeriksaan statis atau registry).
Di awal: `ghostex board associate legend-v4ld`, `bd update legend-v4ld --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: helper pagar, titik panggil di service/skrip impor, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, migrasi, logika bisnis di luar pemanggilan pagar.

## Bukti selesai
`LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`. Commit lokal di `ws/data-import-guard`, jangan push.

## Laporan
SHA, daftar jalur impor dan statusnya, hasil gate, bead baru.
