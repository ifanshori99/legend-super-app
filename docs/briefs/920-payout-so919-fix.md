# 920 Perbaikan SO 919 payout beku (2 P1 + 1 P2)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang + akses: architect xhigh. Spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per temuan, satu implementer per temuan, test-runner, architect). Lapor sekali saat selesai; tunggu job latar dengan Monitor, jangan akhiri giliran untuk kabar antara. Typecheck penuh sekali sebelum lapor.
Cabang: worktree-mu dari `ghostex/918-payout-3-p2-l2zru-bekukan-batch` (ffd47408f); commit dan push tanpa force. Migrasi sementara mulai 0662. Tidak merge, tidak deploy.
Temuan: `git show origin/qa/second-opinion-payout-918:docs/qa/second-opinion-payout-918.md`.
Keputusan CTO:
- P1 buka beku dengan cookie sesi saja: buka beku (dan "Bukan saya") wajib grant step-up sekali pakai lewat grantor seperti langkah payout lain; tanpa grant ditolak.
- P1 ekspor batch saudara tidak terserialisasi dengan pembekuan: pembekuan dan ekspor/settle/retry mengambil kunci yang sama dengan urutan terdokumentasi (mis. kunci per payslip/item set atau per batch saudara), dan cek beku diulang setelah kunci di transaksi yang sama. Test konkurensi deterministik (transaksi pg manual) gagal-dulu.
- P2 posting beku menggagalkan jurnal lock: pembekuan tidak boleh membuat jalur posting/penutupan periode gagal atau setengah jadi. Uang yang sudah keluar ke bank tetap dicatat; yang ditahan hanya langkah yang mengeluarkan uang baru. Desain final dari architect.
Bukti: test gagal-dulu lalu hijau per temuan, test payout lewat heavy setelah commit terakhir, migrator non-superuser, pra-gate AGENTS.md, architect xhigh tanpa P1.
Laporan: SHA, migrasi, hasil test, temuan architect, angka subagent. Buat/komentari kartu.
