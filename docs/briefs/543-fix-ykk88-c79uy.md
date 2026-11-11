# 543 Fix SO Codex: legend-ykk88 + legend-c79uy
Peran: engineer (~/.agents/team/roles/engineer.md). Keputusan sudah diambil; kerjakan sesuai kartu (`bd show <id>`).
Worktree: `git worktree add .worktrees/fix-ykk88-c79uy -b ws/fix-ykk88-c79uy origin/milestone/m1` (ede015c9). Rentang migrasi bila perlu: 0368-0370.
- legend-ykk88 (uang): waktu fakta monoton per tagihan setelah lock, supaya refund sah tidak dikarantina dan refund tidak sah tetap ditolak. Test bukti tidak ada pihak dibayar lebih.
- legend-c79uy (akses): P1 otorisasi ulang setelah lock di hris-employee-manager.service.ts (serialisasi dengan cabut peran); P2 backfill-employee-managers.ts pakai waktu terbaru setelah lock.
- Tambahan: test backfill 0283 dengan tenant ber-template role (owner/tenant_admin) — dulu belum pernah dijalankan pada baris nyata.
Paralel: 1 implementer per kartu + test-writer, reviewer di akhir. Test gagal-dulu, test terarah lewat heavy, commit per kartu, bd status review. Jangan merge.
