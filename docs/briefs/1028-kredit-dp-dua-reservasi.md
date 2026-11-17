# 1028 Kredit DP satu intent dua reservasi setelah refund provider (legend-mez2n)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore finalizeReservationDepositRemainders + alokasi 1020, test-writer gagal-dulu, implementer).

Base: `ghostex/1020-so-recon-ronde-2-fix` (c15dd03aa; kredit DP pindahan dibatasi net sumber, alokasi `created_at, id`, snapshot 0636, flag recon 0637). Cabangmu antre SESUDAH 1020. Thread 1025 bekerja di base sama pada fundBlockedSql/markProviderRefunded/webhook refund; jangan sentuh berkas itu.
Masalah: DP satu intent dipakai dua reservasi; setelah refund provider berapa pun, refund dipotong penuh per alokasi sehingga apply kredit sah ditolak 409 `CUSTOMER_CREDIT_NOT_AVAILABLE`. Outlet tidak rugi, kredit sah tamu terkunci.
Perilaku: refund provider dibagi ke alokasi sekali (urutan sama dengan 1020), total potongan = refund provider, tidak per alokasi penuh. Jumlah kredit semua reservasi <= net intent. Bila ragu, membatasi (1020) tetap berlaku.
Test wajib: dua reservasi satu DP, refund provider sebagian -> kredit gabungan = net, tiap reservasi tidak negatif, apply kredit sah lulus; refund penuh -> semua kredit 0; event ganda; tenant lain; outlet tidak rugi, tamu tidak dibayar lebih; berkas 1020 tetap hijau. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0645-0646. Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
