# Brief: engineer — perbaikan temuan Codex refund recovery (legend-h1dyy)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti.

## Worktree
`.worktrees/94q2l-impl` (cabang ws/94q2l-impl, HEAD b78f169c). Commit di cabang yang sama.

## Tujuan
Tutup 3 temuan second-opinion Codex (brief 372). Tiap temuan: test gagal-dulu dengan angka contoh di bawah, lalu fix.
1. P1 `apps/api/src/services/order-recovery-refund.ts:338`: refund melewati evaluasi ulang promo. Contoh: 2 kopi Rp100.000 + croissant gratis Rp20.000; refund croissant menghasilkan Rp16.667, seharusnya Rp0. Fix: pakai port refund promo yang sudah ada untuk hitung nominal dan sesuaikan redemption/klaim promo.
2. P2 `order-recovery-refund.ts:698`: penolakan refund hanya memulihkan jurnal. Contoh: member dapat 100 poin, request refund separuh memotong 50 poin, payout ditolak, poin tidak kembali. Fix: kompensasi loyalty idempoten saat penolakan.
3. P2 `apps/api/src/services/order-recovery-refund-amount.ts:60`: pembulatan per komponen mengabaikan refund terdahulu. Contoh: 2 item Rp50.005, PBJT awal Rp10.001, setelah keduanya direfund pembalikan PBJT Rp10.002. Fix: alokasi kumulatif; refund terakhir mengambil sisa tiap komponen (subtotal, service, PBJT), tidak pernah melebihi nilai awal.

## Cakupan
Berkas di atas, test-nya, helper langsung. Tanpa migrasi; bila wajib, pakai 0249, jangan menomori ulang. Desain uang: kerja dengan Opus high.

## Bukti
- 3 test baru gagal sebelum fix, lulus sesudah; test refund yang ada tetap hijau.
- `heavy` typecheck api, test file refund/recovery terkait. Batas Retro 11: 2x gagal typecheck, baca log.
- Satu subagent architect xhigh (uang) mereview diff fix.

## Laporan
Commit SHA, test yang ditambah, hasil typecheck/test, temuan architect dan penanganannya.
