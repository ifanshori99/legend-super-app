# Brief lanjutan G5qo3: kekurangan potongan PPh21 jadi piutang karyawan (legend-kn3n bagian 2, legend-xzid, legend-6ajk)

## Peran
Engineer. Baca ulang `~/.agents/team/roles/engineer.md` bila konteksmu sudah compact.

## Cabang
Lanjut di `ws/pph21-overwithhold` (worktree `.worktrees/pph21-overwithhold`, HEAD 1535d4d8, belum masuk m1). Jangan push, jangan merge.

## Keputusan founder B8 (mengikat)
Kekurangan potongan PPh21 karyawan dicatat sebagai PIUTANG KARYAWAN, bukan beban perusahaan. Setoran ke negara tetap = T. Tidak ada gross-up atas kekurangan ini. Berlaku untuk kelebihan di atas batas gaji tersedia (bulan TER dan Desember) dan karyawan keluar/Desember tanpa gaji. Penagihan: dipotong dari gaji berikutnya sampai batas gaji tersedia; sisa saat karyawan keluar tetap piutang terbuka untuk ditagih finance. Detail di `bd show legend-kn3n`.
- Bagian (1) kn3n (default riwayat campuran proportional vs gross_first) BELUM diputuskan: jangan ubah default, biarkan ke konsultan pajak legend-8463.

## Tujuan
1. Engine: ganti "ditanggung perusahaan permanen + gross-up" untuk kelebihan di atas cap menjadi piutang karyawan. Invariant: setoran = T, take-home tidak negatif, potongan karyawan bulan ini tidak melebihi cap, piutang = T - potongan karyawan (tanpa gross-up). Penagihan piutang lama di slip berikutnya sampai cap, urutannya ditetapkan bersama subagent architect (sebelum/sesudah pinjaman).
2. legend-6ajk (Codex 156 run 3, `docs/briefs/156-second-opinion-pph21-overwithhold.result3.md`): evaluasi ulang di bawah mekanisme baru; bila jalur settlement masih ada, W tidak boleh naik akibat settlement; tambah regresi ambang PKP dari laporan itu.
3. legend-xzid: builder payslip produksi mengisi `employeeWithholdingCapIdr` = tunai tanpa tunjangan PPh - semua BPJS karyawan - potongan pra-net non-pinjaman.
4. Penyimpanan dan jurnal piutang (tabel/migrasi baru bila perlu, akun piutang karyawan, tampil di slip): putuskan bersama architect, ikuti pola modul pinjaman bila cocok. Migrasi baru: catat nomor dan `when`; merge train yang menomori ulang.

## Kartu
`ghostex board associate` untuk legend-kn3n, legend-xzid, legend-6ajk; `bd update <id> --status in_progress`. Saat lapor: `--status review` dan `bd comment` bahasa biasa.

## Scope
Jangan sentuh: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, auto-journal POS/refund, `pos-shift.service.ts`.

## Bukti selesai
Test reproduksi dulu (gagal sebelum fix), termasuk kasus R63 dan ambang PKP 6ajk. `LEGEND_TEST_FILES` daftar eksplisit (`src/test/payroll*`, dibuat dengan bash nullglob, jalankan lewat `bash -c`), laporkan jumlah file jalan. tsc api/shared lewat `heavy`, eslint, prettier. Review K: subagent reviewer Opus + architect paralel, temuan nyata dibetulkan. Brief Codex `docs/briefs/170b-second-opinion-pph21-receivable.md` (tidak di-commit, hanya diff baru, tanpa temuan Claude).

## Laporan
Sekali setelah ketiga kartu selesai: hasil, contoh angka Rupiah (R63 sebelum/sesudah), bukti, file berubah, SHA, keputusan desain + alasan, risiko, kebutuhan dari CTO.
