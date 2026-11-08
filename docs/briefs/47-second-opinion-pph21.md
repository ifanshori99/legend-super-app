# Brief: second-opinion — engine PPh 21 dan test referensi (legend-5cnk)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-pph21-tests`, cabang `ws/payroll-pph21-tests` (HEAD `34a5e2d`). Diff: `git diff main...ws/payroll-pph21-tests`.

## Fokus (uang dan pajak)
- `apps/api/src/services/payroll-pph21.ts` (`computePph21Period`): TER bulanan PP 58/2023, hitung ulang di masa pajak terakhir (Desember atau bulan keluar), Pasal 17 HPP, PKP dibulatkan ke bawah ribuan, PTKP, biaya jabatan 5% maks Rp6 jt/tahun.
- Skema gross / gross-up (iterasi konvergen, tunjangan = pajak) / net; skema campuran per komponen dan pembagian refund.
- Tambahan 20% tanpa NPWP (bulan TER dan tahunan), urutan pembulatan.
- Tabel `apps/api/src/test/fixtures/payroll/statutory-tables.ts`: cocokkan PTKP, TER A/B/C (44/40/41 lapisan), Pasal 17 dengan sumber resmi/terpercaya.
- 36 kasus R01–R36: nilai harapan independen dari engine? Hitung ulang sampel sendiri. Cari kasus tepi yang hilang (bulan keluar tengah tahun, THR+bonus, iuran BPJS perusahaan sebagai penghasilan).
- 5 asumsi yang dicatat engineer (biaya jabatan pro-rata Rp500rb × bulan, 20% di bulan TER, K/I/n = K/n, alokasi proporsional skema campuran, nomor pasal PMK 168): beri pendapat dan sumber bila ada.
- Integer IDR, tanpa float yang bocor ke hasil.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret (input, nilai salah vs benar), fix. "Tidak ada blocker" bila memang tidak ada.
