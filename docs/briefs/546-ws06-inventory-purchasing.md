# 546 WS-06 inventory/purchasing backend (4 kartu)
Peran: engineer (~/.agents/team/roles/engineer.md). Baca kartu (`bd show <id>`); cek `git log --all --grep=<id>` dan kode m1 dulu.
Worktree: `git worktree add .worktrees/ws06-purchasing -b ws/ws06-purchasing origin/milestone/m1`. Migrasi 0376-0380 (dnex 0376, d78a 0377), `when` di atas m1 terakhir.
Kartu: legend-dnex (jenis/tag supplier goods|maintenance + fixture supplier teknisi), legend-ca3c (kontrak saran AI purchasing + preview PDF PO), legend-mgy0 (read model nama staf untuk opname dan waste), legend-d78a (bukti foto waste lewat transport storage `/api/storage/uploads`; bergantung legend-3sbl — bila belum ada, laporkan dan lewati).
Jangan sentuh area edge, payroll, HRIS, akuntansi, refund, config codecs, CRM.
Paralel: Explore, test-writer, 1 implementer per kartu (mgy0 dan d78a sama-sama di inventory-waste.service.ts: satu worker berurutan), reviewer di akhir. Test gagal-dulu, test terarah lewat heavy, tsc api/shared, eslint/prettier. Commit per kartu, jangan merge/push. Lapor dengan angka subagent.
