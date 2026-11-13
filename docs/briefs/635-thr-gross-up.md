# Brief: engineer — pajak THR karyawan gross-up ditanggung perusahaan

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + pajak). Keputusan sudah diambil founder; implementasi saja.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/payroll-followups` (origin, 72fd67d5e). Push ke `origin` sebagai `fix/thr-gross-up`.

## Kartu
`legend-x7jas` (baca `bd show`). Keputusan founder Q9 (13 Nov 2026): karyawan dengan skema pajak **gross_up** = pajak THR juga ditanggung perusahaan (tunjangan pajak), sama seperti gaji bulanan. Karyawan skema potong (net/gross biasa) tetap dipotong dari THR. Sekarang kode memotong pajak THR dari THR semua karyawan.

Aturan R1 (Q5 belum dijawab, tetap sementara): kenaikan TER gaji pokok di bulan THR ditanggung mengikuti slip sebelumnya. Jangan ubah.

## Aturan uang (founder)
Test gagal-dulu: karyawan gross_up menerima THR bersih = THR bruto (pajak ditanggung perusahaan, tunjangan pajak tercatat dan masuk penghasilan bruto sesuai cara gross-up yang sudah dipakai gaji bulanan); karyawan potong tetap dipotong; total PPh 21 Desember tahunan tetap benar; ekspor bank = total transfer. Tidak ada karyawan dibayar lebih dari aturan, outlet tidak menanggung pajak karyawan non-gross-up.

## Pembagian paralel
Explore (alur THR + gross-up gaji bulanan), test-writer, implementer 1, `architect` effort xhigh atas diff, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck api lewat `heavy` sekali sebelum lapor. Test terarah dari ROOT worktree.

## Batas
Tanpa migrasi (butuh: lapor). Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
