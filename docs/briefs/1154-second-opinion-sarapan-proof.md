# 1154 Second opinion sarapan bukti penyedia (fix SO 1146)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff 013a20709..origin/ws/1130-p2-pajak-sarapan-rekap` (head 86ed0ec32). SO sebelumnya: `docs/qa/second-opinion-sarapan-1130-1146.md`.
Isi: `handleBreakfastPaymentPaid` memutuskan `refuse` lokal dulu; valid = langsung `paid` tanpa panggilan penyedia; jalur tolak melempar `BreakfastProviderProofNeeded` sebelum menulis; `withBreakfastProviderProof` bertanya ke penyedia di luar transaksi lalu mengulang sekali dengan `providerProven` (refuse dihitung ulang di bawah lock); dipakai di `worker-main.ts` dan `deliverOrderPaymentEvent` tanpa tx; jawaban tak jelas = 409 `PAYMENT_PROVIDER_UNCONFIRMED`.
Diterima CTO (jangan dilaporkan): jawaban tak jelas di jalur tolak menggagalkan job sampai dead letter (~155 detik), pemulihan replay manual, uang tetap di outlet.
Cari terutama: retry mengulang consumer lain dalam `deliver` yang sama (mis. `handlePaymentPaid`, outbox, poin, jurnal, notifikasi) — apakah ada efek ganda (dibayar/dicatat/dipotong dua kali); pembayaran sah yang ditolak atau dibatalkan; refund/batal tanpa bukti penyedia; lock outbox/offset; lintas tenant.
Hasil: tulis `docs/qa/second-opinion-sarapan-proof-1154.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
