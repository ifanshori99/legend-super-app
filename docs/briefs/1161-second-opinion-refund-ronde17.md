# 1161 Second opinion refund ronde 17 (1144 putaran 2)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff 41b89605d..origin/ws/1144-refund-hold-echo` (head d217d439d). Ronde 16: `docs/qa/second-opinion-refund-ronde16-1153.md`.
Isi: hold echo kecil ditutup hanya oleh webhook sukses milik R sendiri; R `approved` atau `refund.failed` = hold tetap terbuka + satu alert; ID dedup alert stabil `reconHoldAlertId` (tenant, integrasi, intent, refund id) lintas retry dan jalur announce.
Diterima CTO (jangan dilaporkan): hold tidak tertutup otomatis bila R selesai lewat `runRefundPayout`/`settleRefundManually` atau R sudah `completed` saat retry (menunggu finance); ID dedup tanpa payment ref/jumlah; jalur `unmatched` tanpa saklar mati belum memakai ID stabil; payload lama tanpa `payment_id_unusable`; penanda `auto_closed`.
Cari: P2 ronde 16 benar tertutup; hold ditutup tanpa uang R benar sukses; uang keluar melebihi pembayaran; alert hilang sama sekali (dedup terlalu luas lintas tenant/intent); lintas tenant.
Hasil: tulis `docs/qa/second-opinion-refund-ronde17-1161.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
