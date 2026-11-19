# 1160 Second opinion approval waktu ronde 2 (fix 1151 atas SO 1148)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff bf1567dec..origin/ghostex/fix-so-approval-waktu -- apps/api packages/shared` (head e1020c77e). Ronde 1: `docs/qa/second-opinion-approval-waktu-1148.md`.
Isi: waktu cek = paling akhir dari `options.now`, waktu fakta refund, dan `Date.now()` sesudah SEMUA lock (termasuk `lockAndCheckSoleOwnerSelfApproval`); `decided_at` = waktu cek; terlambat = `APPROVAL_REQUEST_EXPIRED`.
Diterima CTO (jangan dilaporkan): peran approver dimuat sebelum lock (legend-k8g62); UPDATE menunggu lock sweep sesudah waktu cek -> `NOT_PENDING`; `caller.data` dimuat sebelum lock.
Cari: P1/P2 ronde 1 benar tertutup; jalur lain yang masih mengambil jam sebelum lock; pemanggil (cuti, koreksi absen, stok opname, lembur, payout/refund approval) yang kini salah menolak keputusan tepat waktu atau menerima yang terlambat; `createdAt`/`deadlineAt` level berikutnya; lintas tenant.
Hasil: tulis `docs/qa/second-opinion-approval-waktu-r2-1160.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
