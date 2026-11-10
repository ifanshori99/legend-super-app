# 424 Desain verifikasi WhatsApp masuk lewat Kirimdev (legend-w8dfz)

Peran: architect. Baca `~/.agents/team/roles/architect.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Effort xhigh (akses dan data pribadi).

## Tujuan
Desain teknis (bukan kode produk) untuk verifikasi WhatsApp **masuk**: pengguna mengirim kode dari nomornya ke nomor WhatsApp kita (tautan wa.me berisi teks kode), Kirimdev meneruskan pesan masuk ke webhook kita, web menampilkan popup sukses. Tidak ada balasan WhatsApp (pesan keluar mahal). Dipakai untuk:
1. Reset PIN slip gaji oleh karyawan dari nomor terdaftar (keputusan founder Q10). Menggantikan OTP keluar di cabang `ws/qih2m-payslip-otp` / `fix/codex-418-pin`.
2. Login pelanggan lewat WhatsApp (arah founder, belum ada PRD rinci): catat desain yang bisa dipakai ulang, tandai bagian yang butuh keputusan founder.

## Bahan (paralel, giliran pertama)
- web-fetch: https://docs.kirimdev.com/ (webhook pesan masuk, autentikasi/tanda tangan webhook, kirim pesan, batas, harga bila ada) dan https://kirimdev.com/features/kichat/ (apakah KiChat berguna untuk kita).
- Explore: repo `/Users/ifanshori99/Projects/legend super app/119connect-portal-alumni-main` — modul Kirim/Kirimdev yang bisa dipakai ulang (klien, verifikasi webhook, login inbound bila ada).
- Explore: di legend, port `MessagingProvider`, alur reset-otp payslip PIN (`git show origin/fix/codex-418-pin` atau `.worktrees/fix-418`), dan kode WhatsApp/Kirim yang sudah ada.

## Yang harus dijawab di dokumen
- Alur lengkap (diagram urutan): buat tantangan (kode acak, TTL, terikat sesi browser + karyawan/tenant), tautan wa.me, webhook masuk, pencocokan nomor pengirim dengan nomor terdaftar, penandaan selesai, web tahu sukses (polling atau SSE), lalu set PIN baru.
- Keamanan: verifikasi asal webhook (tanda tangan/secret), replay, kode ditebak/brute force, nomor dipalsukan, kode dicuri lewat tangkapan layar (ikat ke sesi), rate limit, audit, data pribadi (simpan hash nomor? masa simpan pesan).
- Multi-tenant: satu nomor WhatsApp platform untuk semua tenant atau per tenant; cara memetakan kode ke tenant.
- Kontrak API dan skema tabel (nama, kolom, indeks, RLS), rentang nomor migrasi: pakai nomor sementara, merge train yang renumber.
- Konfigurasi: nama env key (tanpa nilai), mode sandbox untuk dev/test, adapter palsu untuk test.
- Pemecahan kerja jadi 3 sampai 6 kartu bd yang filenya terpisah (buat kartunya, `bd create`, tautkan ke legend-w8dfz).
- Yang butuh keputusan founder (biaya bulanan Kirimdev, nomor WhatsApp, dll): tulis sebagai daftar pendek dengan rekomendasi.

## Keluaran
- `docs/design/whatsapp-inbound-verification.md` di cabang `ws/kirimdev-inbound-design` dari `origin/milestone/m1` (worktree `.worktrees/kirim-design`). Commit dan push.
- Jangan menulis kode produk. Jangan membaca `.env`. Kunci produksi tidak dibutuhkan untuk desain.
- Laporan: ringkasan alur, risiko utama, kartu yang dibuat, pertanyaan untuk founder.
