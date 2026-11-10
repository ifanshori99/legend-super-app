# 191b hasil architect 1 (review ganda Claude, brief 225)

Kartu: legend-lg45. Kode diperiksa: `milestone/m1` 94d769c6 (merge 694d3af6 = ws/edc-pan-tail bff215af). Tidak ada perubahan sesudahnya pada 0143, skrip, `packages/shared/src/edc/index.ts`, runbook.

Hasil: **Bersih** (tidak ada temuan P1/P2).

## Bukti
- Fuzz paritas SQL vs JS: 6100 pesan (2942 tepat 200 UTF-16, termasuk emoji, `Rp 1.500.000`, `TRX 12345678`, `P261109-1234`, mask utuh/terpotong, tab, ` - `), simulasi jalur tulis lama (`[0-9]([ -]?[0-9]){11,}` lalu `.slice(0,200)`). Ekspresi `message` CASE dari 0143 dijalankan di PostgreSQL 17 (DB test sementara, tabel temp) dan dibandingkan dengan `maskStoredMessage`: 0 beda. 0143 dua kali: 0 beda. JS baca atas hasil 0143: 0 beda. Tidak ada hasil > 200 code point.
- Uji kebocoran: 12 pola pengelompokan PAN 16-19 digit x 8 pemisah x 3 awalan, potong di tiap posisi. Semua sisa > 6 digit masuk residual yang sudah dicatat runbook bagian 6 (potong sebelum pemisah lebar pertama; 7 digit + satu spasi; sesudah `digit,`/`digit.`). Tidak ada kebocoran baru.
- Semantik ARE vs JS: aturan ujung berjangkar `$` (tanpa flag `n`/`m`), jadi akhir match tetap dan awal leftmost; greedy/lazy di dalam lookahead tidak mengubah hasil. Lookbehind negatif panjang-variabel sama di keduanya. `[\u0001-￿]` di bracket valid di ARE (standard_conforming_strings on).
- Klausa WHERE konsisten dengan CASE: baris 200 yang hanya cocok sesudah rantai tertangkap lewat klausa rantai.
- FORCE RLS: satu blok DO, NO FORCE/UPDATE/FORCE gagal bersama; policy tidak disentuh. Migrator tidak memeriksa hash, jadi edit di tempat aman untuk boot.

## P3 (cukup dicatat)
- `docs/runbooks/edc-pan-scrub.md` bagian 6 "Detection": "sesudah 0143 baru harus 0" hanya benar sesaat setelah migrasi. Jalur tulis baru masih bisa menyimpan baris tepat 200 yang berakhir `[disamarkan] - 51` atau `… 1234567  ` (lalu disamarkan saat dibaca), jadi hitungan bisa naik lagi. Saran: tambahkan "baris yang dibuat sesudah deploy bisa terhitung; bandingkan dengan `created_at` < waktu deploy".
- Positif palsu baru hanya pada pesan tepat 200: nominal tanpa titik + pemisah lebar di ujung (`Rp 1500000  `), `P261109 - 1234` (spasi-strip-spasi). Sesuai desain (tidak bisa dibedakan dari potongan kartu), hanya jalur baca/tampilan.
- Skrip fallback hanya berguna bila operator mencocokkan hash 0143 lama; tidak ada pengaman di skrip itu sendiri, tapi skrip idempoten dan aman dijalankan pada DB dengan 0143 baru (0 baris).
