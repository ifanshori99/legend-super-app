# 1053 Kas kecil: tolak batch gaji tunai bila saldo kurang (legend-rvao9) + urutan kunci (legend-f250r)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Tingkat K (uang): architect xhigh sekali di akhir (checklist interleaving roles/architect.md).
Langkah pertama: spawn paralel Explore (jalur approve batch gaji tunai, guard return kas 1037, semua pengambil lock periode/entity), test-writer gagal-dulu per kartu, implementer per kartu.
Base: `origin/ghostex/b49350e5` 69461a987 (1037). 
- rvao9: founder Q43 = tolak persetujuan batch gaji tunai bila saldo kas kecil (GL 1102 dikurangi uang menunggu jurnal/cadangan, sama dengan guard return 1037) < total batch. Pakai lock entitas yang sama dengan return supaya tidak berlomba. Pesan galat jelas untuk finance.
- f250r: SO 1049 temuan 2 (docs/qa/second-opinion-kas-payout-ronde2-1049.md): kunci periode vs entity terbalik antara jurnal manual/berulang dan return kas -> deadlock. Satu urutan lock di semua jalur, test dua transaksi berlawanan arah tidak deadlock.
Test: tidak ada yang dibayar dua kali, kas tidak minus, bersamaan (approve gaji x return x top-up), tenant lain. Migrasi kerja 0666-0667 hanya bila perlu.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
