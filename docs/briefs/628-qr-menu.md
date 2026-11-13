# Brief: engineer — QR order dan menu (WS-03)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat S (split bill menyentuh tagihan: review `architect` effort high untuk kartu itu).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (origin). Push ke `origin` sebagai `ws/qr-menu`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-iuvq`: consumer outbox cetak menu + sweep 30 detik.
2. `legend-arp35`: panel split ke API split bill.
3. `legend-tct6`: foto menu QR dari media.
4. `legend-8qri`: tema tenant dan zona waktu di perjalanan QR.
Tampilan baru di luar mockup yang sudah disetujui: lewati dan laporkan. Jangan sentuh alur QRIS hold/DP dan pembayaran.

## Migrasi
Tanpa migrasi. Butuh tabel: laporkan dulu.

## Aturan uang
Split bill: total semua bagian = total tagihan (tidak lebih/kurang sepeser), test gagal-dulu.

## Pembagian paralel
Explore, test-writer, implementer per kartu, reviewer + architect high untuk arp35, `ui-auditor` untuk layar QR yang berubah, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck lewat `heavy` sekali sebelum lapor. Screenshot 390 di `docs/screenshots/qr-menu/`.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
