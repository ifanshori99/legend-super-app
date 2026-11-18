# 1057 Payout clearance sidik bukti (legend-63gyr) + lembur dari roster (legend-arj.2) + runbook push_subscriptions (legend-ony4b)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. 63gyr tingkat K (uang): architect xhigh sekali di akhir. arj.2 dan ony4b tingkat S.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: Explore per kartu, test-writer gagal-dulu (63gyr, arj.2), implementer per kartu (berkas tidak bertumpuk).
Base: origin/1038-payout-recon-clearance d62aaa8fa (berisi 1052 payout recon). Migrasi kerja 0672-0673 hanya bila perlu.
- legend-63gyr (P1 uang): flag clearance payout lama masih melepas flag setelah bukti fisik berubah (sidik 0464). Cek dulu apakah d62aaa8fa (1052) sudah menutupnya; bila ya, buktikan dengan test lalu tutup kartu. Bila belum: clearance wajib terikat ke sidik bukti saat ini, fail closed.
- legend-arj.2 (P2): jenis hari lembur diambil dari roster, bukan input karyawan (WS-10 BE). JANGAN sentuh payroll GL / accounting-journal (thread 1053); bila perlu, berhenti dan laporkan.
- legend-ony4b (P1 docs): runbook menemukan id baris push_subscriptions yang tidak terbaca, di docs/runbooks.
Test 63gyr: tidak ada slip dibayar dengan bukti usang, tidak dibayar dua kali, tenant lain ditolak.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
