# Brief: engineer — perbaikan kecil ops dan menu (3 kartu)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S, kecuali 0pth (migrasi) = K.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1`. Push ke `origin` sebagai `ws/ops-menu-small`.

## Kartu (baca `bd show <id>`; cek dulu `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-svmj`: catat sumber 86 (staf vs otomatis) di `item_availability` agar perbaikan otomatis tidak pernah mencabut 86 yang dipasang ulang staf (`menu-pricing.service`).
2. `legend-j5e3`: samarkan jumlah pergerakan stok di `GET /api/audit/events` untuk hitung buta (blind count), sesuai izin.
3. `legend-0pth`: kolom `uploaded_by` di `core_storage_objects`, diisi dari user terverifikasi; data lama boleh null.

## Migrasi
Rentang `0476-0477` saja. `db:generate` kosong setelahnya.

## Pembagian paralel
Satu implementer per kartu (file terpisah), test-writer (test gagal-dulu per kartu), reviewer: `reviewer` sonnet untuk svmj+j5e3, `architect` effort xhigh untuk 0pth (migrasi). Satu `test-runner` pemegang heavy; tanpa loop sleep (run_in_background + Monitor). Typecheck sekali di akhir.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck api via `heavy`; prettier + eslint.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
