# Brief: engineer — panic relay di bawah beban (alarm darurat)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (keselamatan: alarm darurat). Akar belum jelas: mulai dengan satu subagent `architect` effort high untuk analisis akar.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (origin, 4d299ba5e; alarm darurat sudah ada). Push ke `origin` sebagai `fix/panic-relay-load`.

## Kartu (baca `bd show <id>`)
1. `legend-a43bt`: saat beban (3 berkas test paralel), EM-19 Q94 gagal walau tunggu 15 detik dan EM-01 gagal di SLO 5 detik. Dugaan: receipt hilang di `recordReceipt` (`apps/api/src/services/panic-relay.service.ts:734`). Reproduksi dengan test beban yang deterministik, buktikan akar, perbaiki kode bila nyata. Jangan melonggarkan SLO.
2. `legend-gyqdh`: hook waktu di panic-relay untuk menguji timer fallback POS 15 detik (aturan founder Q94: tanpa jawaban 15 detik, alarm tampil di semua layar POS outlet, nama ruangan + jam saja).

Lihat juga cabang `fix/webhook-retry-guard` (7304b5180) yang memisah `PANIC_TEST_WAIT_MS`; jangan bentrok, cukup ikuti polanya.

## Bukti
Test gagal-dulu untuk akar yang ditemukan; 3 berkas panic/edge dijalankan paralel 3 kali hijau (lewat `heavy`). Bila akar ternyata bukan bug produk, jelaskan dengan bukti.

## Pembagian paralel
architect (akar, high), Explore, test-writer, implementer 2 (per kartu), architect high atas diff, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck api lewat `heavy` sekali sebelum lapor. Test terarah dari ROOT worktree.

## Batas
Tanpa migrasi (butuh: lapor dulu). Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
