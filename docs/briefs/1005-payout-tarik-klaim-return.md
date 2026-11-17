# 1005 Payout: tarik klaim return dua orang (legend-snwnn)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang + migrasi): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur return claim 990 + pola clearance dua orang 990, test-writer gagal-dulu, implementer).

Base: `ghostex/92055877` (74e142d8b, 990: bank ref wajib di return, clearance 2 orang, migrasi kerja 0580-0584). Cabangmu antre SESUDAH 990.
Masalah (kartu legend-snwnn): klaim return payout yang terbuka tidak bisa ditarik. Ref bank salah ketik di langkah 1 membuat konfirmasi selalu PAYOUT-89 dan item tidak bisa diajukan ulang (PAYOUT-63). Migrasi 0583 berhenti bila ada klaim terbuka tanpa bank_ref, jadi ops juga butuh jalan keluar.
Buat: withdraw klaim return tepercaya dua orang, mengikuti pola clearance 990 (pengusul tidak boleh menyetujui, termasuk sesi yang sama; tiap langkah cek kata sandi; attestation tercatat dan dicek recon). Setelah withdraw disetujui, item kembali ke status sebelum klaim dan bisa diajukan ulang dengan ref baru. API saja (layar menyusul bersama legend-o2b4m).

Jangan sampai rugi, test wajib: withdraw tidak pernah menghapus/mengubah jurnal yang sudah terposting; item tidak bisa dikonfirmasi return dua kali; tidak ada pembayaran ulang otomatis; satu orang tidak bisa withdraw sendirian; recon menandai withdraw tanpa attestation sah; tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi kerja 0585-0589 BUKAN milikmu (dipakai 991); pakai 0615-0618 (lapor CTO bila lebih). Jangan sentuh payroll/payout di luar alur return dan recon yang perlu.
Bukti: suite payout terarah (sebut berkas) lulus, prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
