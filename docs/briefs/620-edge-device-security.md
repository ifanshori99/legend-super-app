# Brief: engineer — keamanan dan admin perangkat edge (2 kartu)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K untuk hbqj (auth), S untuk 2lp.6.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1`. Push ke `origin` sebagai `ws/edge-device-security`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-hbqj`: pepper PIN staf di box edge diturunkan per tenant (bukan satu pepper global), file `config/env.ts` dan `device-pin-pepper.ts`. PIN lama harus tetap bisa diverifikasi selama migrasi (rotasi aman), dan pepper tidak pernah tercatat di log.
2. `legend-2lp.6`: CRUD registry printer (`edge_printers`) di bawah izin `device.registry.manage`: router + service + validator shared, filter tenant/outlet di SQL.

Jangan sentuh alarm darurat/panic (thread lain).

## Migrasi
Rentang `0480-0481` saja. `db:generate` kosong setelahnya.

## Pembagian paralel
Explore (pola route perangkat + pepper), test-writer (gagal-dulu: pepper beda per tenant, PIN lama tetap valid saat rotasi, CRUD printer lintas tenant ditolak, tanpa izin 403), implementer 2 (per kartu), `architect` effort xhigh untuk hbqj + `reviewer` untuk 2lp.6, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
