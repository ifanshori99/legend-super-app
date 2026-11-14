# Bukti pemeriksaan mockup panik

Scope: artefak review lokal saja. Semua tombol simulasi; tidak ada request ke API, PIN asli, kredensial, atau perubahan aplikasi.

## Render dan inspeksi

- `heavy ghostex visual check design/mockups/panic/review.html --out design/mockups/panic/review.png`: pemeriksaan awal 390 dan 1280, keduanya Fits. Tool menambahkan akhiran lebar jika tanpa `--width`.
- Capture final memakai `--width 1280 --out .../review.png` dan `--width 390 --out .../review-mobile.png`; keduanya Fits. Capture 320 juga Fits. Output lengkap di `visual-check.txt`.
- Enam state dan alternatif B punya PNG desktop 1280 dan mobile 390. Parent memeriksa review desktop; subagent memeriksa enam PNG mobile satu per satu. Teks tidak terpotong atau bertabrakan. Perbaikan minor pemisah ID antrean dicapture ulang.
- Incoming mobile mempunyai CTA terlihat tanpa scroll pada 390×844, hasil audit browser: y=580, tinggi 64 px. Body minimal 18 px; footer dan label minimal 16 px.

## Audit browser dan perbaikan

`audit-browser.cjs` dijalankan serial melalui `heavy`, Playwright 1.63.0 dan axe-core 4.14.0, memakai dependency lokal yang sudah tersedia. Tidak membuka browser Ghostex bersama.

- Run awal: tujuh layar × 1280/390/320 = 21 kombinasi. Enam layar selain antrean lulus. Axe menemukan mismatch nama aksesibel dua tombol antrean; diperbaiki agar teks terlihat menjadi awalan nama aksesibel. Beberapa assertion awal label daftar juga terlalu spesifik dan diperbaiki menjadi pemeriksaan makna status.
- Run final: antrean 1280/390/320, tiga kombinasi lulus, nol failure. `audit-results.json` menyimpan run sebelumnya, hash sumber, hasil axe, dan run terbaru. Tidak ada pelanggaran axe serious/critical pada hasil setiap layar setelah perbaikan yang relevan.
- Diperiksa: overflow, reduced motion, fokus keyboard terlihat, aksi utama 390×844, ACK tunggal, tiga ACK independen, hitungan menunggu, label setelah seluruh ACK, tombol nonaktif, daftar tetap terlihat, simulasi PIN, native details revoked, dan error JavaScript.
- Review menemukan status ACK lama belum berubah; status, judul, hitungan, nama aksesibel, serta instruksi nol antrean telah diperbaiki. Reviewer kode tidak menemukan masalah tersisa pada perbaikan akhir.
- Axe mempunyai item kontras incomplete pada panah dekoratif `aria-hidden`; bukan violation. Pemeriksaan token manual menghasilkan putih/merah 5,81:1, muted/canvas 6,25:1, putih/petrol 7,30:1. Panah memakai putih/merah yang sama.

## Pemeriksaan sumber

- Prettier 3.9.6, `--ignore-path /dev/null --check`, pada HTML/CSS/JS/CJS/Markdown: lulus. Folder desain diabaikan konfigurasi formatter repo; override memastikan berkas benar-benar diperiksa.
- ESLint 9.39.5 standalone, aturan `no-undef` dan `no-unused-vars`, pada kedua script browser: lulus. `node --check` pada keduanya: lulus.
- `pnpm exec prettier` dan `pnpm exec eslint` mula-mula tidak tersedia karena worktree desain tidak memiliki node_modules. Pemeriksaan final memakai executable yang sudah terpasang di worktree integrasi; tidak mengubah manifest atau dependency aplikasi.
- Typecheck, suite aplikasi, dan production build: N/A untuk artefak HTML statis dalam folder desain. Tidak ada paket aplikasi, migrasi, kontrak API, atau katalog teks produksi yang diubah.

## RYUX delivery gate

| Area          | Hasil | Bukti dan batas                                                                                                                                                                         |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product       | PASS  | Enam state brief tersedia; bukti kuat dari brief dan kontrak repo. Data contoh ditandai.                                                                                                |
| UX            | PASS  | Lokasi dan aksi terbaca; ACK tidak menyatakan insiden selesai. Belum diuji dengan staf.                                                                                                 |
| UI            | PASS  | Task UI kontras tinggi mengikuti DESIGN.md; dua arah untuk gerbang founder.                                                                                                             |
| Design system | PASS  | Satu keluarga Plus Jakarta Sans, skala spasi dan warna status konsisten.                                                                                                                |
| Accessibility | PASS  | Kriteria otomatis di atas, kontras token, keyboard, reduced motion. Bukan sertifikasi WCAG atau uji pembaca layar nyata.                                                                |
| Responsive    | PASS  | Render 1280/390, pemeriksaan 320 dan audit browser tiga lebar.                                                                                                                          |
| Edge cases    | PASS  | Koneksi ulang, unreachable, revoked, ACK bersamaan dan antrean direpresentasikan.                                                                                                       |
| Code quality  | PASS  | Syntax, format, lint script, simulasi browser; kode aplikasi N/A.                                                                                                                       |
| Visual QA     | PASS  | Ghostex visual check, inspeksi desktop dan enam PNG mobile; screenshot di folder ini.                                                                                                   |
| Anti-slop     | PASS  | Satu aksen petrol; merah/amber sebagai status, satu keluarga netral, radius 8/12 px dan lingkaran status, satu ukuran display utama per arah, tanpa emoji UI/gradien/dekorasi bergerak. |
| Final         | PASS  | Artefak mockup terverifikasi sesuai scope; pemilihan arah dan asumsi operasional masih gerbang founder.                                                                                 |

## Belum diverifikasi

Penerimaan WS sungguhan, latensi darurat, fallback jaringan, race ACK backend, pemetaan nama ruang, pembaca layar nyata, zoom browser 200%, perangkat fasilitas, suara/getaran, dan uji kegunaan dengan staf. Approval founder belum diterima. Tidak ada klaim siap produksi.
