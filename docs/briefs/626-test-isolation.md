# Brief: engineer — isolasi test API (2 kartu)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S (hanya kode test dan setup test).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `int/batch55` (origin; berisi `fix/flaky-restore-window` yang memaksa vitest 1 worker). Push ke `origin` sebagai `fix/test-isolation`.

## Kartu (baca `bd show <id>`)
1. `legend-pkt5t`: `DELETE FROM platform_admins` tanpa filter di ~9 `afterAll`. Hapus hanya baris yang dibuat file itu (filter id/email unik per file).
2. `legend-z68ds`: flake `hris-leave-carry-expiry-db` dan `hris-leave-collective-reversal` saat suite paralel: beri fixture tenant/karyawan sendiri.

Cari juga (Explore) DELETE/TRUNCATE tanpa filter lain di `afterAll`/`afterEach` di `apps/api/src/test/` dan betulkan dengan pola yang sama. Jangan ubah kode produk.

## Bukti
Jalankan berkas yang diubah dua kali bersamaan dengan `VITEST_MAX_WORKERS=2` (lewat `heavy`) dan hijau. Laporkan apakah batas 1 worker bisa dicabut; jangan cabut sendiri.

## Pembagian paralel
Explore (cari pola), implementer 2-3 (berkas terpisah), reviewer, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Test terarah dari ROOT worktree.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
