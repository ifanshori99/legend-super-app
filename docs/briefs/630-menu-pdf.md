# Brief: engineer — mesin PDF cetak menu

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/qr-menu` (origin, a572311a0). Push ke `origin` sebagai `ws/menu-pdf`.

## Kartu (baca `bd show <id>`)
1. `legend-hspr8`: ubah port renderer cetak menu dari `render(html)` menjadi `render(model)` dan bangun renderer dengan `pdf-lib` 1.17.1 yang sudah ada. Tanpa dependency baru. Font yang mendukung teks Indonesia dan simbol Rupiah; teks panjang dibungkus; banyak halaman.
2. Selesaikan `legend-iuvq`: renderer terpasang, sweep 30 detik aktif, outbox cetak menu menghasilkan PDF tersimpan di storage tenant.

Desain renderer generik (blok teks, tabel, header logo) agar nanti bisa dipakai slip gaji/struk, tapi jangan bangun slip/struk sekarang.

## Bukti
Test: model menu 3 kategori -> PDF valid (halaman >= 1, teks nama item dan harga ada), menu panjang -> lebih dari 1 halaman, tenant lain tidak bisa membaca PDF. Simpan satu contoh PDF di `docs/screenshots/menu-pdf/` dan render halamannya ke PNG untuk dicek.

## Pembagian paralel
Explore (port renderer + storage), test-writer, implementer 2 (renderer; wiring sweep/storage), reviewer, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck lewat `heavy` sekali sebelum lapor.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
