# Brief: engineer — perbaikan temuan Codex gateway Duitku (legend-rgddb)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti. Uang: kerja dengan Opus high.

## Worktree
`git worktree add .worktrees/duitku-fix -b ws/duitku-codex-fix milestone/m1`. PORT dan nama DB sendiri.

## Tujuan
Tutup 4 temuan second-opinion Codex (brief 374). Tiap temuan: test gagal-dulu, lalu fix.
1. P1 `apps/api/src/services/payment-duitku.ts:258`: lookup kredensial untuk intent yang sudah tersimpan masih memeriksa paket tenant. Setelah Duitku dicabut, callback VA lama ditolak dan polling gagal, dana tidak terekonsiliasi. Fix: pisahkan "boleh membuat intent baru" (cek paket) dari "ambil kredensial untuk intent tersimpan" (tanpa cek paket, tetap per tenant/outlet).
2. P1 `apps/api/src/services/payment-duitku-webhook.service.ts:510`: dedup terminal memakai `resultCode` yang tidak masuk tanda tangan. Replay callback gagal dengan kode diubah 02->00 mengisi event "sukses", lalu callback paid asli dibuang sebagai duplikat, intent tertinggal failed tanpa polling. Fix: kunci dedup hanya dari field bertanda tangan; untuk duplikat pada intent belum lunas, konfirmasi lewat API status Duitku sebelum menolak; status akhir hanya dari hasil cek status.
3. P2 `payment-duitku-webhook.service.ts:486`: nominal callback dan nominal hasil cek status tidak wajib sama dengan tagihan (100000 lunas oleh 99999 atau 100001). Fix: lunas hanya bila callback == status == tagihan; selain itu catat sebagai selisih untuk rekonsiliasi, intent tidak lunas.
4. P2 `payment-duitku-webhook.service.ts:343`: callback paid mengubah failed/expired menjadi paid tanpa aturan. Keputusan CTO: dana yang benar-benar masuk tidak diabaikan.
   - Intent failed/expired, pesanan belum punya pembayaran lunas lain, nominal cocok: boleh menjadi paid (dicatat sebagai pelunasan terlambat di audit).
   - Pesanan sudah lunas lewat cara lain atau dibatalkan: intent tidak dijadikan pelunas; catat dana sebagai kelebihan bayar di antrean rekonsiliasi/refund dan jurnal kas gateway vs utang ke pelanggan.
   - Sesuaikan test yang sekarang mengharuskan flip tanpa syarat.

## Cakupan
Berkas di atas, test-nya, helper langsung. Migrasi bila wajib: rentang 0250-0251, jangan menomori ulang.

## Bukti
- Test baru tiap temuan gagal sebelum fix, lulus sesudah; test pembayaran lain tetap hijau.
- `heavy` typecheck api, test file payment/duitku terkait. Batas Retro 11: 2x gagal typecheck, baca log.
- Satu subagent architect xhigh (uang) mereview diff fix.

## Laporan
Commit SHA, test ditambah, hasil typecheck/test, temuan architect dan penanganannya.
