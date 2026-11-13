# Brief: engineer — alur kunci run payroll (pajak bulanan + snapshot rekening)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + pajak). Desain baru di area uang: mulai dengan satu subagent `architect` effort xhigh untuk desain singkat sebelum implementer.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `fix/payroll-money` (0638b6e5; berisi ws/payroll-bank-coretax). Push ke `origin` sebagai `ws/payroll-run-lock`.

## Kartu (baca `bd show <id>`)
1. `legend-b9y4y` (P1): belum ada service create/simulate/lock run payroll umum. Bangun langkah kunci run: dalam satu transaksi panggil `calculatePayrollRunTax`/`lockPayrollRunTax` dengan monthScope (advisory lock bulan, cek `PAYROLL_PPH21_MONTH_STALE`) dan `snapshotPayeeBankForLock` untuk slip bank_transfer net>0. Pembatalan (reversal) run mengambil lock bulan yang sama dan ditolak selama run berikutnya di bulan itu bergantung padanya. Cek dulu PRD/design (`docs/`) dan route payroll yang ada agar sesuai alur persetujuan.
2. `legend-yod9z` (P2): ekspor bank belum bisa membaca slip hasil finalisasi rapel (amplop bruto). Buat ekspor membaca nilai bersih dari slip itu dengan aturan PAYR-04 yang sama.

Aturan pembagian kenaikan TER (R1, sementara menunggu founder Q5): ikuti pembagian pajak slip sebelumnya; jangan ubah kecuali CTO mengirim keputusan lain.

## Migrasi
Rentang `0478-0479` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: kunci run menulis pajak bulanan + snapshot dalam satu transaksi; dua kunci paralel bulan sama tidak dobel/kurang potong; reversal ditolak bila run kemudian bergantung; ekspor rapel = total transfer run. Tidak ada karyawan dibayar lebih, outlet tidak rugi.

## Pembagian paralel
architect (desain, xhigh), test-writer, implementer 2 (run lock + reversal; ekspor rapel), architect xhigh atas diff akhir, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
