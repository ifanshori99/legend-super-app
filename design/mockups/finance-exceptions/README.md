# Review pengecualian finance

Page: `review.html`. Mockup lokal untuk gerbang founder, mengikuti warna hangat, aksen teal, tipografi Jakarta, dan kepadatan backoffice. Data seluruhnya contoh; tidak ada permintaan API atau mutasi transaksi.

## Rencana

1. Memeriksa kontrak lima jenis pengecualian, batas tanggal, cakupan outlet, dan perilaku nilai null.
2. Menyusun ringkasan per jenis, filter, daftar dengan referensi yang dapat dibuka, serta versi mobile.
3. Menyediakan empat kondisi melalui kontrol review dan query `?state=normal|empty|error|loading`, kemudian memeriksa visual 1440 dan 390.

## Layar dan kondisi

- Normal: delapan kejadian contoh dari lima jenis; ringkasan jumlah dan nilai rupiah yang diketahui per jenis.
- Kosong: lima kategori nol dan penjelasan yang terbatas pada filter aktif, dengan aksi mengatur ulang filter.
- Error: daftar dan ringkasan tidak ditampilkan sebagai nol; filter tetap ada dan “Coba lagi” memuat ulang contoh lokal.
- Memuat: skeleton mengikuti bentuk ringkasan dan daftar; tidak menampilkan nilai lama atau nol sementara.
- Filter lokal: jenis, outlet, tanggal; validasi tanggal wajib, urutan tanggal dan batas inklusif 92 hari. Kartu ringkasan dapat dipilih sebagai filter jenis.
- Detail referensi: elemen native `details` memperlihatkan penjelasan sumber, tanpa payload pribadi.

## Tiga keputusan desain

1. Ringkasan berisi satu blok per jenis, bukan satu angka “kerugian”. Nilai pajak, total order dan biaya transfer memiliki arti berbeda dan tidak dijumlah menjadi kewajiban.
2. Mobile memakai ringkasan vertikal dan baris daftar berbentuk kartu; nilai rupiah, outlet dan jenis tetap terbaca tanpa geser horizontal. Kontrol utama minimal 44 px.
3. Cakupan “Seluruh PT” dibedakan dari outlet. Filter outlet mengecualikan biaya payout dengan penjelasan tetap terlihat; nilai yang tidak tersedia ditulis demikian, tidak diubah menjadi Rp0.

## Kesesuaian kontrak

Sumber `origin/ws/finance-exceptions`: `packages/shared/src/validators/finance-exceptions.ts`, `packages/shared/src/types/api.ts`, `apps/api/src/routes/accounting-finance-exceptions.routes.ts`, `docs/briefs/662-finance-exceptions-contract.md`.

- `from` dan `to` wajib, tanggal bisnis `YYYY-MM-DD`, maksimum 92 hari inklusif; `kind` dan `outletId` opsional.
- Respons memiliki `summary`, `items`, dan `truncated`. Daftar maksimum 500 terbaru; ringkasan mencakup seluruh hasil, termasuk bila daftar terpotong.
- Nilai item boleh null. Nilai ringkasan menjumlah nilai yang diketahui; nilai seluruh kategori tidak tersedia ditulis “Nilai tidak tersedia” pada mockup, tanpa menyatakan sumber menyediakan total pasti.
- Biaya payout hanya terlihat bagi pengguna seluruh tenant tanpa filter outlet. Semua data contoh payout berlabel “Seluruh PT”.
- API hanya baca. Mockup tidak menyediakan aksi jurnal, retry pembayaran, atau penyelesaian kejadian. Kondisi error lokal bukan bukti koneksi API telah diuji.
- Nama outlet dan nomor referensi pendek adalah contoh presentasi; kontrak hanya mengirim ID. Implementasi perlu lookup nama outlet dari data yang sudah diizinkan, bukan menambah klaim nama pada DTO.

## Asumsi untuk review founder

- Istilah “Pengecualian finance” serta lima label mengikuti brief. Apakah istilah edge dan payout cukup dipahami pengguna finance, atau label perlu disederhanakan sebelum implementasi?
- Daftar ini hanya pemeriksaan. Tombol penyelesaian tidak disediakan sampai tersedia alur dan izin terpisah yang disetujui.

## Delivery Gate

- Pembacaan kontrak dan cek batas folder: dilakukan oleh author.
- Interaksi lokal dan render Chrome telah diperiksa: normal/kosong/error/memuat pada 1440, 390, dan 320; tanpa overflow atau exception JavaScript. Ghostex check desktop/mobile dilampirkan sebagai PNG. Fokus kategori memakai outline ke dalam, teks utama mobile 16 px.
- API, otorisasi, penghitungan backend dan mutasi uang: tidak diuji dalam tugas mockup ini; tidak ada kode aplikasi diubah.

## Artefak dan batas verifikasi

PNG `finance-exceptions-<state>-desktop.png` dan `finance-exceptions-<state>-mobile.png` memuat empat kondisi. Pemeriksaan kedua area dapat diulang melalui `heavy node design/mockups/payout/render.mjs`; hasil terstruktur ada di `../payout/verification.json`. Alat hanya memakai Chrome yang terpasang dan Node, tanpa server aplikasi atau dependensi baru. Font Jakarta Sans tertanam supaya halaman mandiri dan diterima Ghostex.

Delivery Gate lengkap kedua area ada di `../payout/README.md`. Filter lokal, null, cakupan biaya PT dan validasi tanggal diuji di browser. API/otorisasi/penghitungan backend, axe, pembaca layar dan Lighthouse belum diverifikasi. Ringkasan fixture dihitung dari data contoh kecil; implementasi produksi wajib membaca `summary` server, bukan menghitung ulang dari maksimal 500 `items`.
