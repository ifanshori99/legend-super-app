# Brief: engineer — kontrak pengaturan tenant + akses dukungan (3 kartu)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S, kecuali `legend-2gvt` (akses dukungan): K, review `architect` effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (origin). Push ke `origin` sebagai `ws/tenant-config-contracts`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-s6o8`: kontrak shared `deleteTextOverride` + endpoint impor config bertenant.
2. `legend-at8c`: test kontrak (CT) untuk text-override org, impor config tenant, endpoint media brand.
3. `legend-2gvt`: daftar sesi akses dukungan mengirim `serverNow` + nama tampilan Super Admin.

Filter tenant di SQL, izin lewat `requirePermission`. Teks UI baru: daftarkan ke katalog (`node --test tests/text-contract.test.mjs`).

## Migrasi
Rentang `0488-0489` saja, bila perlu. `db:generate` kosong setelahnya.

## Pembagian paralel
Explore (pola route config + support access), test-writer (gagal-dulu: tenant lain ditolak, tanpa izin 403), implementer 3 (per kartu), reviewer untuk 1-2, architect xhigh untuk 3, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir. Test terarah dari ROOT worktree.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
