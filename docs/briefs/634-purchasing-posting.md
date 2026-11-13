# Brief: engineer — posting faktur pemasok + lanjutan AP/AR

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + migrasi). Desain posting baru: mulai dengan satu subagent `architect` effort xhigh untuk desain singkat.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/purchasing-apar` (origin, 7ec074441). Push ke `origin` sebagai `ws/purchasing-posting`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>`)
1. `legend-29vw`: akun barang diterima belum difaktur (GRNI) di peta akun, lalu jurnal faktur pemasok (penerimaan: debit persediaan / kredit GRNI; faktur: debit GRNI + PPN masukan / kredit utang). Peta akun hilang -> parkir `ACCOUNT_MAPPING_MISSING`. Setelah lulus, `SUPPLIER_INVOICE_POSTING_ENABLED` boleh default on hanya bila semua test uang hijau; bila ragu tetap off dan lapor.
2. `legend-gzeya`: aset tetap dibeli kredit membuat open item utang pemasok.
3. `legend-3fi5v`: debit note yang posting AP-nya gagal tidak memblokir retur sah berikutnya (tanpa membuat utang berkurang dua kali).
4. `legend-ct27s`: cek aset-vs-faktur dalam transaksi yang sama (dua permintaan bersamaan tidak lolos).
5. `legend-smrwb`: sisi AR dari legend-uyk2, bila ada pemanggil nyata; bila belum ada pemanggil, lapor dan lewati.

Aturan sementara yang menunggu founder (jangan dilonggarkan): toleransi bawaan 0% maks 10%, retur melebihi sisa utang ditolak, baris jasa selalu ditahan.

## Migrasi
Rentang `0494-0495` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: jurnal faktur seimbang dan sekali (kirim ulang tidak dobel); GRNI nol setelah penerimaan + faktur cocok; aset kredit tidak tercatat utang dua kali; dua permintaan bersamaan tidak lolos cek; tenant lain ditolak. Pemasok tidak dibayar lebih, outlet tidak rugi.

## Pembagian paralel
architect (desain, xhigh), test-writer, implementer per kartu (maks 4 mengedit, file terpisah), architect xhigh atas diff akhir, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck api lewat `heavy` sekali sebelum lapor. Test terarah dari ROOT worktree.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
