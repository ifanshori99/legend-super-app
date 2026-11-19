# 1148 Second opinion approval waktu pasca-lock (1137 ijy8u)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff origin/milestone/m1...origin/ghostex/ai-layar-approval-waktu-1137 -- apps/api packages/shared` (head bf1567dec). Brief: `docs/briefs/1137-ai-layar-approval-waktu.md`.
Isi: `decideApprovalRequest` memakai waktu sesudah `lockChain` untuk cek peran, tenggat level, `deadlineAt`/`createdAt` level berikutnya; `options.now` eksplisit + waktu tunggu lock (dipakai hris-leave, attendance-correction, inventory-count); waktu cek = `decided_at`; terlambat = `APPROVAL_REQUEST_EXPIRED`, rollback.
Diterima CTO (jangan dilaporkan): peran approver dimuat sebelum lock (legend-k8g62, P2).
Cari: keputusan yang lolos sesudah tenggat; dua approver bersamaan pada level yang sama; jam klien/opsi yang bisa dipalsukan dari API; pemanggil lain `decideApprovalRequest` yang kini salah waktu (cuti, koreksi absen, stok opname, payout/refund approval); lintas tenant.
Hasil: tulis `docs/qa/second-opinion-approval-waktu-1148.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
