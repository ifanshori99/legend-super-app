# Brief: engineer — retry webhook terlalu cepat + flake edge

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang: webhook pembayaran) untuk kartu 1; S untuk kartu 2.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (origin, 4d299ba5e). Push ke `origin` sebagai `fix/webhook-retry-guard`.

## Kartu (baca `bd show <id>`)
1. `legend-okrmg`: event webhook berstatus `received` dengan `attempts=0` diretry setelah 1 menit, melewati pengaman "masih diproses" (5 menit). Keputusan CTO: tahan baris `received` sampai batas 5 menit, sama dengan pengaman yang ada. Reproduksi dulu dengan test (gagal-dulu), lalu perbaiki. Pastikan juga dedupe mencegah proses ganda bila dua worker mengambil event yang sama.
2. `legend-gcdq0`: flake `edge-access-applier` dan `panic-relay` saat beban. Cari akar (waktu, data bersama, urutan), perbaiki test atau kodenya; bukan menaikkan timeout semata.

## Aturan uang (founder)
Test gagal-dulu: event yang sedang diproses tidak diproses dua kali; pembayaran tidak tercatat ganda; event macet tetap diretry setelah 5 menit.

## Pembagian paralel
Explore (alur webhook retry + dua test edge), test-writer, implementer 2 (per kartu), `architect` effort xhigh atas diff kartu 1, reviewer kartu 2, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck api lewat `heavy` sekali sebelum lapor. Test terarah dari ROOT worktree.

## Migrasi
Tanpa migrasi. Butuh: lapor dulu.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy; jangan panggil DOIT/Duitku sungguhan. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
