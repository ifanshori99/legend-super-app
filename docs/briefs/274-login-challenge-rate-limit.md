# Brief lanjutan G998f: rate limit HTTP login-challenges

Lanjutan di thread yang sama, sesudah commit senderMasked. Aturan sama dengan brief 265.

## Repo
Cabang `ws/auth-audit-trail`, lanjut di atas commit senderMasked. Worktree yang sama. Jangan push, jangan merge. Tanpa migrasi.

## Tujuan
`legend-fc0f2` (P1, tingkat K akses). `/api/auth/login-challenges` dipasang sebelum `publicRateLimit` (`app.ts` sekitar :288 vs :371), jadi tanpa rate limit HTTP. Pasang rate limit per IP dan per cookie binding sebelum layanan menyentuh DB, memakai mekanisme rate limit yang sudah ada di app (jangan pustaka baru). Logika AUTH-04 (5 challenge per cookie/IP) tidak diubah. Jawaban 429 memakai bentuk galat yang sudah dipakai `publicRateLimit`. Perhatikan urutan middleware di `app.ts` (baca komentarnya) dan `TRUST_PROXY`.

## Kartu
Awal: `ghostex board associate legend-fc0f2`, `bd update legend-fc0f2 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Bukti selesai
- Test gagal-dulu: banjir POST melewati batas menjawab 429 tanpa menambah baris `audit_logs` dan tanpa transaksi DB; IP lain tetap dilayani; alur login normal (AUTH-04) tetap lulus.
- Tes terarah 5 file lama + file baru, sebut jumlah file dan tes. Typecheck api lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K): satu `architect` untuk diff ini saja.

## Laporan
Sekali di akhir: SHA senderMasked dan SHA rate limit, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan. Tambahkan bagian rate limit ke `docs/briefs/265b-second-opinion-auth-audit.md`.
