# 425 Mockup lupa PIN slip gaji lewat WhatsApp masuk

Peran: designer. Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`.

## Tujuan
Ganti layar "Lupa PIN" lewat WhatsApp di alur PIN slip gaji. Cara baru (keputusan founder): karyawan menekan tombol yang membuka WhatsApp dengan pesan berisi kode sudah terisi, mengirimnya dari nomor terdaftar ke nomor WhatsApp kita, lalu kembali ke web dan melihat popup sukses, lalu membuat PIN baru. Tidak ada kode yang diketik dari WhatsApp; tidak ada balasan WhatsApp.

## Bahan
- Layar PIN yang sudah dibangun: `.worktrees/payslip-pin-ui/design/screenshots/payslip-pin/` (baca satu per satu, terutama `lupa-pin*`, `buat-pin*`). Mockup lama di `design/` cabang itu.
- Layar yang perlu: (1) pilihan lupa PIN (WhatsApp atau minta HR/supervisor), (2) menunggu pesan WhatsApp (kode tampil, tombol buka WhatsApp, instruksi singkat, hitung mundur kedaluwarsa, tombol salin kode untuk WhatsApp di perangkat lain), (3) popup sukses terverifikasi lalu lanjut ke buat PIN, (4) gagal: kode kedaluwarsa, nomor pengirim tidak cocok, terlalu banyak percobaan, (5) nomor belum terdaftar -> arahkan ke HR.
- Lebar 390px (HP), bahasa Indonesia sehari-hari, gaya sama dengan layar PIN yang ada.

## Keluaran
- PNG per layar di `design/mockups/payslip-pin-inbound/` cabang `ws/design-pin-inbound` dari `origin/milestone/m1` (worktree `.worktrees/design-pin-inbound`), plus `README.md` berisi alur dan teks tiap layar. Commit dan push.
- Laporan: daftar layar dan keputusan desain. Jangan mengubah kode aplikasi.
