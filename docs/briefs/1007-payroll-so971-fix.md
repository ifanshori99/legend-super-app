# 1007 Perbaikan temuan SO 971 payroll (2 P1 + 2 P2)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang + migrasi): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per temuan, satu implementer per kartu; file terpisah: offboarding/reversal, lembur, PPh21 open items, ledger pinjaman).

Sumber: docs/qa/second-opinion-payroll-955.md (lokasi, skenario, perbaikan, usul test). Base: `ghostex/992-koreksi-lembur-payroll` (001c996be, sudah memuat dd932307 71b1155f7). Cabangmu antre SESUDAH 992.
Kartu:
- legend-xo4cn (P1): reversal run setelah offboarding completed tidak boleh membuat tagihan pinjaman di snapshot pesangon beku menjadi kurang; pilih aturan yang membatasi pembayaran (tolak reversal atau buka tagihan selisih), tulis alasan.
- legend-qcioh (P1): ledger koreksi lembur tidak bisa ditandai reversed selama pembayaran asal berlaku; run berikutnya tidak membayar ulang.
- legend-2ln9t (P2): reversal penagih piutang PPh21 tanpa DELETE (baris pembalik/status, sesuai hak role aplikasi).
- legend-rtrbj (P2): UPDATE principal ikut trigger pembuktian saldo terhadap ledger.

Jangan sampai rugi, test wajib: tidak ada lembur dibayar dua kali; pesangon tidak menagih kurang/ganda; saldo pinjaman selalu cocok ledger; reversal tidak gagal karena izin DB di role aplikasi (test dengan role aplikasi); tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi kerja 0621-0624 (lapor CTO bila lebih); migrasi baru saja, RLS/FORCE tetap.
Bukti: test payroll/hris terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent.
