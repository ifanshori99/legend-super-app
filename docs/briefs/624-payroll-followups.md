# Brief: engineer — lanjutan payroll (simulasi tersimpan, pajak Desember, rapel bisa dikunci)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + pajak + migrasi). Desain baru di area uang: mulai dengan satu subagent `architect` effort xhigh untuk desain singkat sebelum implementer.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/payroll-run-lock` (origin; berisi fix/payroll-money + ws/payroll-bank-coretax). Push ke `origin` sebagai `ws/payroll-followups`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-c2yca` (P1): simulasi payroll menyimpan hasil per karyawan; kunci run membaca hasil tersimpan itu, bukan angka kiriman pemanggil. Sertakan route lock bila belum ada.
2. `legend-q5dx4` (P1): PPh 21 tahunan Desember lintas dua run (gaji + THR/bonus Desember). Sampai kartu ini selesai, run kedua Desember tetap ditolak; setelah selesai, run kedua menghitung tahunan dengan benar.
3. `legend-ele0u` (P2): run yang berisi rapel tidak bisa dikunci (lock menolak, finalisasi rapel butuh run terkunci). Putus lingkaran ini tanpa melewati pemeriksaan pajak.

Aturan R1 (sementara, founder Q5 belum menjawab): kenaikan TER di bulan THR ditanggung mengikuti slip sebelumnya. Jangan ubah kecuali CTO mengirim keputusan lain.

Jangan sentuh QRIS, settlement, kas bank.

## Migrasi
Rentang `0486-0487` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: lock memakai hasil simulasi tersimpan (angka kiriman berbeda ditolak/diabaikan); total PPh 21 setahun dua run Desember = perhitungan tahunan (tidak lebih/kurang potong); run rapel bisa dikunci dan ekspor = total transfer. Tidak ada karyawan dibayar lebih, outlet tidak rugi.

## Pembagian paralel
architect (desain, xhigh), test-writer, implementer 3 (per kartu), architect xhigh atas diff akhir, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir. Test terarah dari ROOT worktree.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
