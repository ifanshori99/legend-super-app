# Brief lanjutan: perbaikan uang payroll (thread payroll yang sama)

Tingkat K (uang + pajak). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Lanjut di worktree yang sama, cabang baru dari `ws/payroll-bank-coretax` (cc0c65b6). Push ke `origin` sebagai `fix/payroll-money`.

## Kartu (keputusan CTO; jangan ditanyakan)
1. `legend-89cl7`: snapshot rekening penerima (bank, nomor, nama pemilik) di run payroll saat dikunci (`locked`). Ekspor bank dan pembayaran hanya membaca snapshot; perubahan rekening setelah kunci tidak berlaku untuk run itu. Run lama tanpa snapshot: ekspor ditolak (fail-closed) dengan pesan jelas, bukan membaca rekening terkini.
2. `legend-ihjan`: PPh 21 TER dihitung dari total bruto sebulan bila beberapa run membayar di bulan yang sama (THR/off-cycle): pajak run kedua = TER(total bulan) dikurangi pajak yang sudah dipotong run sebelumnya di bulan itu, dalam lock agar dua run tidak dihitung paralel. Desember/masa terakhir tetap ikut aturan tahunan yang ada. Setelah ini, ekspor Coretax bulan multi-run boleh jalan bila total cocok.

## Migrasi
Rentang `0472-0473` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: rekening diubah setelah kunci -> file bank tetap rekening lama; bulan gaji + THR -> total pajak sebulan = TER(total bruto), tidak kurang dan tidak lebih; dua run paralel tidak dobel/kurang potong. Bila ragu, pilih aturan yang tidak membuat karyawan kurang potong pajak dan outlet tidak bayar dobel.

## Pembagian paralel
test-writer, implementer 2 (snapshot rekening; TER bulanan), satu `architect` effort xhigh atas diff akhir, satu `test-runner` pemegang heavy. Antrean heavy panjang: typecheck sekali di akhir.

## Bukti, batas, laporan
Sama dengan brief sebelumnya. `bd update <id> --status in_progress` di awal, `review` + `bd comment` saat lapor. Wajib baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
