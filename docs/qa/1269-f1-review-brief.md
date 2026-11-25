# 1269 F1 inti perintah edge ke cloud: brief review K (uang)

Worktree `../legend-1269-f1`, diff `7705b4bed..48b30294b`. Acuan: `docs/briefs/1269-f-tiket-poin-dp-standby.md`, `docs/briefs/1269-f1-mulai.md`. Read-only; jangan jalankan suite.

Periksa: satu eksekusi per kunci (bersamaan, crash di tengah, transaksi eksekusi vs catatan hasil); body beda kunci sama ditolak; outlet, node, dan tenant hanya dari token; digest saja cukup untuk replay (hasil lama bisa dikembalikan?); nisan tidak mengalahkan perintah yang masih di jalan; term/instance (`X-Edge-Instance`) dan node lain se-outlet 403 tidak memblokir failover F11b; kedaluwarsa memakai jam siapa; RLS dan grant tabel 0530 (cloud dan edge); expand-only; urutan deploy cloud lalu edge; rate/ukuran body; log tanpa isi.

Keputusan yang diminta:
1. Rancangan hanya menanya status, brief mengizinkan kirim ulang byte sama. Kode: `send` boleh ulang byte sama, pemulihan hanya status. Setuju?
2. `resolveOpen` belum dipasang dan tanpa umur minimum. Usulan CTO: syarat sebelum E9 dipasang, umur minimum > batas timeout kirim + kedaluwarsa, dan nisan ditulis cloud di bawah kunci yang sama.
3. `cloud-http.test.ts` 1 gagal (legend-jcby0, `deviceTokenHashes`): cacat lama dari gabungan E2 atau tes usang?

Laporan maks 12 baris: LULUS / TIDAK, P1-P3 file:baris + perbaikan, jawaban 1-3, boleh tidaknya F3/F11b/E9 mulai.
