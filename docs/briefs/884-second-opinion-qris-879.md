# 884 Second opinion perbaikan QRIS hold 879 (gerbang rilis uang)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Uang dan migrasi: effort xhigh. Read-only, tanpa edit kode produk.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Pakai `git show`/`git diff` atau worktree sendiri; jangan checkout di folder utama. Hapus worktree-mu sendiri setelah laporan di-push.
Cakupan: `git diff origin/milestone/m1...origin/fix/qris-hold-so-879` (tip fd4427fd1; sudah memuat m1 2bf32cd92). Laporan sebelumnya: `docs/qa/second-opinion-qris-hold.md`; brief perbaikan `docs/briefs/879-qris-hold-so-fix.md`.
Cari: apakah 7 temuan 878 benar tertutup; pelanggan bisa bayar lebih dari tagihan atau dua kode tertagih (QR/VA, utuh/split, tamu/kasir, EDC vs QR); outlet menerima kurang; refund ganda atau ke tender salah; void order saat uang masih tertangkap; hold yang bisa dibuka tanpa bukti penyedia; deadlock/urutan kunci; migrasi 0381-0383 dan backfill hold untuk kode lama; test m1 yang diubah (QR→VA) apakah menyembunyikan regresi; pembayaran telat setelah hold tertutup (`BILL_CLOSED` → `payment_unallocated_funds`).
Tanpa heavy kecuali benar perlu satu test terarah.
Hasil: `docs/qa/second-opinion-qris-879.md` (P0-P3, berkas:baris, skenario, usul test), commit ke cabang baru `qa/second-opinion-qris-879`, push tanpa force. Lapor sekali saat selesai.
