# 1171 Second opinion reservasi slot pickup + DP (ws/1163)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff milestone/m1...cca06c1a6` (origin/ws/1163-reservasi-slot-pickup; abaikan commit sesudahnya).
Isi: legend-pdi5u/tkxhs (waktu slot pickup), legend-m0kqn: kode DP penyedia yang tidak pernah final dibatasi `payableUntil + GATEWAY_POLL_WINDOW_MS` (24 jam), lewat batas booking batal `deposit_not_paid`, slot dilepas, audit `providerUnanswered`; pembayaran sesudah batas settle lalu di-refund penuh sekali lewat RSV-02 (`late_refund_requested`), booking tidak dikredit; `sweepStaleDepositHolds` melewati baris yang masih bisa dipolling; guard baris legacy tanpa `deposit_payment_link_id`.
Cari: DP terkredit ke booking batal, refund ganda atau refund melebihi yang dibayar, slot ganda (dua booking di slot sama), slot tertahan selamanya, sweep yang bisa kelaparan, race webhook vs sweep vs pembatalan, lintas tenant/outlet.
Hasil: tulis `docs/qa/second-opinion-reservasi-dp-1171.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
