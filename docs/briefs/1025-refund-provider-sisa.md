# 1025 Refund provider: sisa celah uang (legend-ra4lu, legend-gjt5q, legend-9s33i)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, test-writer gagal-dulu, implementer per kartu; berkas tidak bertumpuk).

Base: `ghostex/1020-so-recon-ronde-2-fix` (c15dd03aa, di atas 1016/1009/980). Cabangmu antre SESUDAH 1020. Jurnal provider refund ada di `ghostex/1013-jurnal-breakfast-net-refund` (b6500814e, saudara di atas 1009): untuk gjt5q, merge 1013 ke cabangmu dulu (`git merge --no-ff origin/ghostex/1013-jurnal-breakfast-net-refund`, selesaikan konflik, catat), lalu antre SESUDAH 1013 juga.
1. legend-ra4lu: `fundBlockedSql` tidak memblokir refund fund lebih bayar bila refund provider tercatat tanpa evidence_id fund. Default membatasi: refund provider tanpa evidence pada intent yang punya fund terbuka memblokir refund fund sampai finance memutuskan.
2. legend-gjt5q: refund provider PENUH (958, markProviderRefunded) tidak menulis `payment_provider_refunds` dan tidak dijurnal. Tulis barisnya sekali (idempoten) dan biarkan event jurnal 1013 `payment.provider_refunded` memostingnya sekali.
3. legend-9s33i: `refund.succeeded` dengan reference intent lain (1020 REFERENCE_MISMATCH) jangan dibuang diam-diam: catat flag recon + alert + blok payout intent sampai finance mencocokkan; tetap tanpa refund/stamp otomatis.
Test wajib: tamu tidak direfund dua kali; outlet tidak membayar payout atas uang yang sudah dikembalikan provider; jurnal sekali (replay/webhook+poller); flag muncul untuk mismatch; tenant lain; kontrol 958/967/980/1009/1013/1016/1020 tetap hijau. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0642-0643.
Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, konflik merge, test, temuan architect, SHA, angka subagent.
