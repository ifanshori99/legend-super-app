# 1008 Perbaikan temuan SO 998 kas dan supplier (2 P1)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang + akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per temuan, satu implementer per kartu; file terpisah).

Sumber: docs/qa/second-opinion-supplier-payout.md F1, F2. Base: `ghostex/991-bayar-supplier-approval-kas` (bbcf73dee). Cabangmu antre SESUDAH 991.
Keputusan founder Q27 (final): pembayaran supplier tetap wajib 2 orang (pembuat bukan penyetuju), juga untuk outlet dengan satu Owner.
Kartu:
- legend-bf8f2 (P1): approve kas keluar tidak boleh melewati tingkat matriks cash_out yang masih pending; tiap tingkat disetujui oleh orang berbeda sesuai peran tingkat itu.
- legend-ycb4h (P1): threshold supplier berapa pun tidak menghapus kewajiban orang kedua. Threshold hanya boleh menambah tingkat, tidak mengurangi di bawah 2 orang. Validasi juga di PUT /api/access/approval-policies (tolak konfigurasi yang membuat 1 orang cukup).

Jangan sampai rugi, test wajib: kas keluar di atas batas tidak terposting sebelum semua tingkat setuju; satu orang (termasuk Owner tunggal) tidak bisa membayar supplier sendirian di nominal mana pun; kebijakan yang melonggarkan ditolak; tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0625-0627.
Bukti: test akuntansi/purchasing terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent.
