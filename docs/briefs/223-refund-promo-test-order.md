# Brief: engineer kecil — urutan baris di test refund promo (legend-4fzhu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/refund-promo-test-order` dari `integ/m1-batch29`. Worktree `.worktrees/refund-promo-test-order`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-4fzhu`: test `apps/api/src/test/pos-refund-promo-db.test.ts` kadang gagal di gate (amount 0, harusnya 30000). Akar masalah sudah ditemukan architect (baca `bd comments legend-4fzhu`): bug test, bukan produk. Test mengurutkan baris refund dengan `ORDER BY created_at` saja; `created_at` memakai jam VM Colima yang disetel mundur ±120 ms tiap 20 detik, jadi dua refund berdekatan bisa tertukar. Produk mengurutkan `refunded_at, id` (`pos-order-corrections.ts:185`).
Perbaikan hanya di file test: urutkan dengan `refunded_at, id` di `refundRows` (sekitar :456), `refundLines` (sekitar :2258), dan subquery "baris terakhir" (sekitar :1959). Tambah satu test deterministik yang membuktikan pembacaan tidak bergantung pada `created_at` (misal dua refund dengan `created_at` disetel terbalik secara manual, hasil tetap urut `refunded_at, id`).

## Kartu
`legend-4fzhu`. Di awal: `ghostex board associate legend-4fzhu` dan `bd update legend-4fzhu --status in_progress`. Saat melapor: `bd update legend-4fzhu --status review` dan `bd comment legend-4fzhu "<ringkasan>"`.

## Scope
Boleh: `apps/api/src/test/pos-refund-promo-db.test.ts` saja. Jangan: kode produk, 43 file test lain yang memakai `ORDER BY created_at` (kartu terpisah, label flake).

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/pos-refund-promo-db.test.ts" pnpm test` lewat `bash -c 'cd <worktree> && pwd && ...'`, lulus 3 kali berturut-turut.
- eslint dan prettier untuk berkas itu. tsc tidak perlu bila hanya SQL di string berubah; bila tipe berubah, satu tsc lewat `heavy`.
- Commit lokal, pesan merujuk legend-4fzhu.

## Laporan
Sekali: hasil, bukti, SHA, risiko tersisa. Kecil dan cepat: tidak perlu reviewer atau architect. Jangan menunggu proses global atau loop sleep.
