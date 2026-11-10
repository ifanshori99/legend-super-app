# Brief: engineer (Sonnet) — dua kartu kecil: snapshot pajak fasilitas, lalu unggah logo tenant

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua cabang terpisah dari `milestone/m1` (ujung terbaru), satu per kartu, berurutan: `ws/tax-snapshot-facility` lalu `ws/brand-logo-upload`. Satu worktree saja (`.worktrees/small-293`, `worktree:setup`): selesaikan kartu A, commit, lalu buat cabang B dari m1 di worktree yang sama (`git switch -c`). Jangan checkout di folder utama. Jangan push, jangan merge.

## Kartu A: `legend-bjy6` (P2, tingkat K: pajak)
`recordTaxSnapshots` sudah dipanggil di QR (`qr-order.service.ts` sekitar :1548, :2038) dan POS (`pos-order.service.ts` sekitar :1225), tapi belum di checkout fasilitas. Cari dulu apakah ada pemanggil lain; bila checkout fasilitas memang belum, tambahkan di transaksi yang sama, idempoten. Tes integrasi checkout untuk ketiga jalur (QR, POS, fasilitas) bahwa snapshot pajak tertulis tepat sekali dan jumlahnya cocok dengan total. Tanpa migrasi. Review: satu `architect`.

## Kartu B: `legend-a30j` (P2, tingkat S kecuali RLS berubah)
Unggah aset merek tingkat tenant (logo/tema): purpose `brand_logo` di `storagePurposeSchema`, unggahan dengan `outletId` null ke bucket publik. `core_storage_objects.outlet_id` sekarang NOT NULL: ubah dengan migrasi yang menjaga RLS outlet untuk baris ber-outlet dan RLS tenant untuk baris tanpa outlet. Nomor dipesan `0201`, `when` 1794280000000. Cek dulu status `legend-tiie` (resolver storage, REVIEW): bila belum di m1 dan dibutuhkan, berhenti dan laporkan. Izin: admin tenant. Tes: tenant lain tidak bisa membaca/menimpa, peran tanpa izin ditolak, unggahan ber-outlet lama tetap jalan. Review: satu `reviewer`; `architect` bila RLS diubah.

## Kartu
Tiap kartu: awal `ghostex board associate <id>` + `bd update <id> --status in_progress`; selesai `--status review` + `bd comment`.

## Bukti selesai (tiap kartu)
- Tes gagal-dulu, `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Kartu B: `pnpm db:generate` lalu periksa SQL; generate kedua kosong; tes migrasi RLS.
- `tsc` api (dan shared bila berubah) lewat `heavy`; eslint + prettier.

## Laporan
Sekali di akhir, per kartu: cabang, SHA, migrasi, bukti, file berubah, risiko. Jumlah subagent dan puncak bersamaan.
