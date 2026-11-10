# Brief: engineer — dua test flaky yang menggagalkan gate merge train (legend-2hqsa, legend-06qw0)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/gate-flakes` dari ujung `milestone/m1` terbaru, worktree `.worktrees/gate-flakes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Gate merge train gagal palsu karena dua test yang bergantung urutan atau waktu. Buat keduanya deterministik tanpa melemahkan apa yang diuji.
- `legend-2hqsa`: `edge-db.test.ts` EDG-03 gagal 409 "Outlet ini sudah memiliki edge node aktif dengan peran tersebut" saat jalan bersama banyak file pin/edge/override/audit/access; sendiri lulus. Dugaan: fixture outlet bersama, file lain meninggalkan edge node aktif. Isolasi outlet per test.
- `legend-06qw0`: `worker-delivery-flow.test.ts:143` `relay()` 0, seharusnya 1, saat beban tinggi; sendiri lulus. Tunggu kondisi, bukan waktu.
Detail: `bd show legend-2hqsa`, `bd show legend-06qw0`.

## Kartu
`legend-2hqsa`, `legend-06qw0`. Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: berkas test dan helper/fixture test. Kode produk hanya bila akar masalahnya memang di sana (catat dan jelaskan). Jangan: skema/migrasi, layanan refund, pos-day, pos-shift, edge PIN, `receipt_sequences`, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Reproduksi dulu: jalankan EDG-03 bersama kelompok file pin/edge/override/audit/access (sekitar 45 file) sampai gagal, dan worker-delivery-flow di bawah beban (mis. bersama file worker/outbox lain), catat perintah dan hasilnya. Sesudah perbaikan: kelompok yang sama lulus 3 kali berturut-turut. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` bila tipe berubah, eslint, prettier. Jangan jalankan `pnpm check` penuh. Review: satu `reviewer` (tingkat S).

## Laporan
Sekali: akar masalah tiap flake, bukti reproduksi dan 3 run lulus, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
