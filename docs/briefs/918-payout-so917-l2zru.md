# 918 Payout: 3 P2 SO 917 + legend-l2zru (bukan saya + bekukan batch)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang + akses: architect xhigh. Spawn subagent paralel dalam satu giliran (Explore, test-writer gagal-dulu, satu implementer per kartu, test-runner, architect). Lapor sekali saat selesai; jangan akhiri giliran untuk kabar antara.
Cabang: worktree-mu dari `ghostex/915-payout-grant-lanjutan` (cbc98a31f); commit dan push tanpa force. Migrasi sementara mulai 0660. Tidak merge, tidak deploy.
Temuan: `git show origin/qa/second-opinion-payout-911-915:docs/qa/second-opinion-payout-911-915.md`.
- legend-87dur: withdraw lalu ajukan ulang tidak boleh jadi `binding_duplicate` di recon.
- legend-fwx7l: migrator tetap punya ADMIN atas role grantor yang sudah ada (provisioning idempoten, non-superuser).
- legend-9n1mu: api tidak boleh lolos kewajiban grantor lewat variabel worker; pengecualian hanya untuk proses worker/edge yang terbukti (mis. entrypoint menandai dirinya), bukan env yang bisa diset di api.
- legend-l2zru: penyetuju asli yang menerima notifikasi bisa menekan "Bukan saya" (step-up password) -> batch dibekukan: semua langkah payout batch itu ditolak sampai Owner/Finance Manager (founder Q12: satu dari keduanya cukup) membuka dengan alasan; tercatat di log append-only. Bila batch sudah exported/terkirim ke bank: bekukan langkah berikut dan buat finance exception. Teks UI baru ke katalog text-contract.
Bukti: test gagal-dulu lalu hijau per kartu, test payout lewat heavy setelah commit terakhir, migrator non-superuser, pra-gate AGENTS.md (prettier, eslint, text-contract, typecheck api+web), architect xhigh tanpa P1.
Laporan: SHA, rentang migrasi, hasil test, temuan architect, angka subagent. Komentari kartu.
