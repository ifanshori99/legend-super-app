# Review C3b + X1-UI kasir VA/e-wallet/EDC manual (ws/1272-c3b 44f4af812)

27 Nov. Reviewer kode (Sonnet) dan ui-auditor (Sonnet), baca kode + screenshot `docs/review/img/c3b-*`. Hasil: 0 P1, 2 P2 (UI), 10 P3. Cek ulang oleh CTO tanpa review ulang.

## Aman (reviewer)
- Satu kode per tagihan: server 409, panel dipilih dari kode hidup; kode tersembunyi/dibatalkan/kedaluwarsa tetap mengunci tagihan.
- Dobel klik: tombol mati saat proses, kunci idempotensi sama.
- Nominal tidak dikirim klien (VA/e-wallet/EDC); error server tampil.
- EDC-04 sesuai X1: tanpa PIN, referensi 6-24, nomor mirip kartu ditolak.

## Wajib dibetulkan sebelum gabung
1. P2 `edc-standalone.tsx:188`: `inputMode="numeric"` menghalangi RRN berhuruf. Pakai `inputMode="text"` + `autoCapitalize="characters"`.
2. P2 `edc-standalone.tsx:89`: angka besar "Nominal pada bukti bank" menampilkan sisa tagihan sebelum slip diisi. Tampilkan "-" sampai terisi; peringatan inline bila nominal beda.
3. P3 (keputusan CTO, paling ketat) `edc-standalone.tsx:57-63`: nominal slip ≠ sisa tagihan = tombol catat nonaktif + pesan "Nominal slip berbeda dari sisa Rp…. Cek slip lagi." (mencegah tagihan terkunci "belum pasti" karena salah ketik).
4. P3 `ewallet-panel.tsx`: `paymentUrl` hanya dirender bila skema `https:`; selain itu sembunyikan link dan QR halaman, tampilkan pesan.
5. P3 sisa: pesan error nominal kosong/0, `maxLength={12}` kode persetujuan, kalimat konfirmasi disembunyikan saat nominal 0, pemisah ribuan; deskripsi VA lewat kunci i18n `{bank}`; baris batas bayar `flex-col items-center` di 390; `aria-label` tab baru; tombol footer 390 `w-full` bertumpuk; `online-code-parts.tsx:257` pakai teks Indonesia (`useEdcErrorText`/`ErrorNotice`).

## Catatan
- Belum ada e2e VA/e-wallet C3b (mock); masuk C5 e2e Duitku sesudah sandbox.
- Kontras belum diukur.
