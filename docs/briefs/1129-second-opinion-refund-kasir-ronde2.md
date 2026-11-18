# 1129 Second opinion refund kasir ronde 2 (1095 sesudah 1116 + 1127)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`):
- Delta sejak SO ronde 1: `git diff a8885a91f..origin/ws/1095-void-refund-ganda-voucher` (head 0b8b9d017).
- Konteks penuh: `git diff origin/milestone/m1...origin/ws/1095-void-refund-ganda-voucher`.
- Temuan ronde 1: `docs/qa/second-opinion-refund-kasir-1095-1114.md`. Brief perbaikan: `docs/briefs/1116-fix-refund-kasir-1095-so.md`, `docs/briefs/1127-fix-1095-late-payment.md`.

Periksa: (1) dua P1 ronde 1 benar tertutup di `services/order-given.ts` (QR belum bayar, refund penyedia); (2) P1 architect 1127: bayar telat QR dihitung 0, pesanan `voided` -> ruang voucher 0, uang parkir (kelebihan bayar, bayar telat) simetris tidak dihitung dibayar dan tidak dikurangkan; (3) urutan apa pun (refund kasir, voucher maaf, void cloud, void edge offline/replay, ORD-09, swap, promo, DP, checkout menebus voucher, bayar telat, kelebihan bayar) yang membuat total keluar ke tamu > dibayar atau outlet rugi; dua koneksi bersamaan; urutan lock; test yang melemahkan jaminan uang.
Diterima CTO (jangan dilaporkan): refund otomatis penyedia mati rilis 1 (Q45); voucher staf di atas sisa ditolak 422; pesanan belum dibayar tidak dapat voucher; deposit DP tidak dihitung dibayar; void ditolak bila voucher maaf sudah dipakai; P3 legend-ee8aa, legend-kbzz6; legend-byws7 dan legend-glu4e (sesudah landing).
Hasil: tulis `docs/qa/second-opinion-refund-kasir-1095-1129.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
