# 793 Second opinion area DOIT dan refund
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Uang: effort xhigh. Read-only, tanpa edit kode produk.
Cakupan: diff `origin/milestone/m1...origin/ws/doit-refund-hardening` (ujung ed32fc48e): webhook refund DOIT dari integrasi nonaktif tanpa `data.reference` (cari integrasi lewat refund, HMAC secret integrasi itu), MFA untuk refund karantina yang dibuka ulang di bawah tier (penanda audit `payment.refund_quarantine_reopened`, tolak >700 hari tanpa MFA), cek flag `DOIT_REFUNDS_ENABLED` API vs worker di `deploy/single-vm/check-refund-flag.sh`, VA lama setelah tamu ganti bank (poll window, satu refund sistem).
Cari: refund ganda atau dibayar lebih (replay webhook, race approve, VA lama dibayar telat), webhook palsu atau lintas tenant yang lolos, jalan pintas MFA (penanda reopen yang bisa dihapus atau dilewati), outlet rugi, flag beda yang lolos deploy.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: tulis `docs/qa/second-opinion-doit-refund.md` di worktree-mu (P0-P3, berkas:baris, skenario gagal konkret, usul test). Lapor ringkasannya.
