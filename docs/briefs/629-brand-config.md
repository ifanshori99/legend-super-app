# Brief: engineer — konfigurasi brand dan tenant (WS-01)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S, kecuali `legend-tj8o` (aturan RBAC): K, review `architect` effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/tenant-config-contracts` (origin, e623ce0b1; berisi kontrak impor config + izin `org.config.import`). Push ke `origin` sebagai `ws/brand-config`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-bkdmc`: logo/tema brand dari upload.
2. `legend-9k0a5`: codec config `wifi_policies`.
3. `legend-datb2`: exporter/importer bundle config (pakai izin `org.config.import` untuk impor, section sensitif tetap diblokir).
4. `legend-tj8o`: FE aturan pemberian izin admin RBAC.
Tampilan baru di luar mockup yang sudah disetujui: lewati dan laporkan.

## Migrasi
Rentang `0492-0493` saja, bila perlu. `db:generate` kosong setelahnya.

## Pembagian paralel
Explore, test-writer (gagal-dulu: tenant lain ditolak, tanpa izin 403, admin tidak bisa memberi izin melebihi miliknya), implementer per kartu, reviewer + architect xhigh untuk tj8o, `ui-auditor` untuk layar yang berubah, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck lewat `heavy` sekali sebelum lapor.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
