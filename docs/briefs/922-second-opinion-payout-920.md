# 922 Second opinion payout 920 (kunci run untuk beku; gerbang rilis uang)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Effort xhigh. Read-only.
Diff: `git diff ffd47408f..origin/ghostex/920-payout-fix-so919-freeze` (tip d06e5a269; migrasi sementara 0662_payout_freeze_run_lock). SO sebelumnya (jangan diulang): `git show origin/qa/second-opinion-payout-918:docs/qa/second-opinion-payout-918.md`.
Diterima CTO (jangan dilaporkan): legend-7gghu, legend-xp8mc (approvedBy belum lewat grant), pengecualian edge EDGE_MODE, kunci run kasar (antre per run).
Cari: deadlock atau urutan kunci yang masih terbalik (run -> batch -> item -> advisory GL) di semua jalur payout termasuk consumer `payroll.locked`, recon, retry, reversal, settle; langkah uang yang masih lolos saat beku; GL tercatat dua kali atau hilang setelah unfreeze; unfreeze tanpa password; run jadi `paid` padahal ada batch beku; lintas tenant.
Hasil: `docs/qa/second-opinion-payout-920.md` di worktree-mu (P0-P3, berkas:baris, skenario, usul test), commit dan push cabang qa tanpa force. Lapor hanya saat selesai.
