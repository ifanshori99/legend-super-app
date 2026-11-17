# 1020 Perbaikan temuan SO recon ronde 2 (legend-qbsbr, legend-svwdz, legend-6jdy1)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per temuan, test-writer gagal-dulu, implementer per temuan; berkas tidak bertumpuk).

Base: `ghostex/1016-refund-kelebihan-provider` (8164b182a, di atas 1009 dan 980; berisi logika net terbaru). Cabangmu antre SESUDAH 1016. Thread 1013 bekerja di berkas akuntansi/breakfast; jangan sentuh berkas itu.
Temuan: `docs/qa/second-opinion-recon-958-967.md` di folder utama repo (baca dari sana; tidak ada di worktree-mu). Cek dulu apakah 980/1009/1016 sudah menutup sebagian; tulis buktinya.
Default membatasi: bila ragu, blok refund tetap berlaku dan kredit DP dikurangi sebesar refund provider (tidak pernah dibayar lebih). Kredit DP yang sudah terpakai sebagian: sisa kredit tidak boleh negatif; selisih yang sudah terpakai dicatat sebagai flag recon, bukan dipotong diam-diam.
Test wajib (usul test di laporan SO): refund ganda tidak mungkin; kredit DP setelah refund provider tidak membayar lebih dari net; reference intent bertentangan ditolak/di-flag; event ganda; tenant lain; outlet tidak rugi, tamu tidak dibayar lebih. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0636-0637.
Bukti: test terarah lulus (sebut berkas, termasuk 958/967/980/1009/1016), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per temuan, test, temuan architect, SHA, angka subagent.
