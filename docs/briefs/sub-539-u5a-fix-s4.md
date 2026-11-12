# Fix S4 (legend-sw980) dari review architect. Urutan 1,2,3,4.

1. totp-enroll.tsx:128-137: gagal generate setelah enrol hanya ada "coba lagi" → pengguna terjebak di /verifikasi. Tambah tombol sekunder "Lewati, buat nanti di Keamanan" yang memanggil refreshAuth() lalu onEnrolled(). Sesi server sudah terverifikasi saat enrol.
2. mfa-verify-page.tsx:169 `showRecovery` mensyaratkan totpFactor → pengguna passkey-saja tak bisa pakai kode cadangan. Pindahkan syarat tampil ke fungsi murni di recovery-state.ts (tanpa syarat TOTP), tambah tautan "Pakai kode cadangan" di cabang passkey (:300) juga. Test node untuk kasus passkey-saja.
3. recovery-section.tsx:60-61 dan totp-enroll.tsx:118: panggil generate.reset() saat "Saya sudah menyimpan kode" supaya kode tidak tertinggal di MutationCache.
4. mfa-panel.tsx:206-209: saat dialog enrol tertutup (termasuk setelah generate gagal), jalankan factors.refetch() dan refreshAuth().
