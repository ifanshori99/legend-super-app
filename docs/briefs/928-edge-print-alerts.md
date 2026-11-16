# 928 Edge print + alert perangkat (area WS-02, 4 kartu)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort high. Tanpa uang/akses; migrasi hanya bila wajib (sementara mulai 0664, tanpa mengubah migrasi lama).
Cabang: worktree-mu dari `milestone/m1` (a8e6036ab); commit dan push tanpa force. Tidak merge, tidak deploy.
Kartu (baca `bd show` tiap kartu dulu): legend-2lp.2 (struk POS lewat Print Agent edge), legend-2lp.4 (laporan tutup shift lewat Print Agent), legend-2lp.5 (alert print ke notifikasi supervisor + kolom audit), legend-4lm6 (adapter heartbeat perangkat + alert operasional).
Paralel: Explore dulu untuk Print Agent/edge yang sudah ada; satu test-writer gagal-dulu per kartu; satu implementer per kartu dengan file terpisah; test-runner; satu reviewer atas diff area. Teks UI baru: daftarkan di katalog (`node --test tests/text-contract.test.mjs`).
Bukti: test gagal-dulu lalu hijau, test area lewat heavy setelah commit terakhir, pra-gate AGENTS.md (prettier, eslint, typecheck api/web sekali).
Laporan: cabang, SHA, migrasi, test, temuan reviewer, angka subagent. Komentari tiap kartu. Lapor sekali saat selesai.
