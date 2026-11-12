# 557 Backend kasir utama + captain (U1 disetujui) + QRIS DP
Peran: engineer (~/.agents/team/roles/engineer.md). UI U1 disetujui founder 12 Nov; UI U2 disetujui, QRIS ber-DP ditahan di UI.
Kartu: legend-dysef (7 gap kontrak di `apps/web/src/features/ws04-pos-order/CONTRACT-GAPS.md` pada origin/ui/pos-cashier-captain: katalog kasir dengan modifier, nomor panggil takeaway, hold per baris, tambah ke sesi QR oleh staf, pesanan diparkir, daftar meja captain, pemetaan panggilan pelayan), legend-y5d2r (QRIS layar pelanggan = sisa tagihan setelah DP, bukan total). Cek dulu `git log --all --grep` dan kode m1: sebagian mungkin sudah ada (mis. nomor panggil legend-ggpoe).
Worktree: `git worktree add .worktrees/pos-order-be -b ws/pos-order-be origin/milestone/m1` (e9bbd9ea). Migrasi 0392-0396.
Urutan: test-writer menulis test kontrak + API dari CONTRACT-GAPS dan UI (gagal dulu), lalu implementer per gap (file sama: berurutan), reviewer akhir.
Uang (y5d2r, pesanan diparkir, hold): test bukti pelanggan tidak ditagih lebih dari sisa, DP tidak terpakai dua kali, outlet tidak rugi. Ragu: pilih aturan yang membatasi pembayaran, laporkan.
Jangan ubah UI (apps/web) kecuali tipe kontrak di packages/shared. Jangan sentuh payroll, akuntansi, CRM, inventory, HRIS, edge sync.
Test terarah lewat `heavy`, tsc api/shared, eslint/prettier, `db:generate` kosong. Commit per gap, jangan merge. Lapor dengan angka subagent, gap yang sudah ada sebelumnya, dan yang belum diuji.
