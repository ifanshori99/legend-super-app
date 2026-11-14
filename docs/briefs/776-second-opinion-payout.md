# 776 Second opinion area payout approval
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Uang: effort xhigh. Read-only, tanpa edit kode produk.
Cakupan: diff `origin/milestone/m1...origin/ws/payout-approval-followups` (persetujuan payout: rekening sumber, nama pengusul, kunci FOR SHARE konfigurasi saat approve, retry web dengan source id terkonfirmasi).
Cari: pihak dibayar lebih atau dua kali, approve terhadap rekening yang tidak dilihat penyetuju, race approve/ubah konfigurasi, bocor data rekening (harus ter-mask ****1234), izin lintas outlet.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: tulis `docs/qa/second-opinion-payout-approval.md` di worktree-mu (P0-P3, berkas:baris, skenario gagal konkret, usul test). Lapor ringkasannya.
