# PIN slip gaji — mockup untuk review

Buka `index.html` untuk indeks seluruh layar dan tautan PNG. Tiap layar tersedia dalam lebar 390 px (`-mobile.png`) dan 1280 px (`-desktop.png`); tinggi menyesuaikan isi. Ini adalah gambar statis dan HTML review, bukan prototipe fungsional. Data periode dan karyawan adalah contoh.

## Layar dan tujuan

- `buat-pin`: Karyawan membuat dan mengulang PIN enam digit.
- `buka-slip`: Karyawan memasukkan PIN untuk membuka slip tertentu.
- `pin-salah`: Kesalahan dekat input, dengan contoh sisa percobaan yang memerlukan dukungan API.
- `terkunci`: Lima kesalahan dan penguncian selama 15 menit.
- `lupa-pin`: WhatsApp belum tersedia; HR dapat mereset tanpa melihat atau menetapkan PIN.
- `ubah-pin`: PIN saat ini, PIN baru, dan pengulangannya.
- `hr-reset`: Konfirmasi reset beserta alasan 3–500 karakter.
- `kosong`, `memuat`, `error`: Kondisi daftar slip.
- `kode-dibatasi`: Respons batas permintaan kode (429) untuk layanan WhatsApp ketika tersedia.
- `pin-tersimpan`: Konfirmasi bahwa PIN aktif.

## Keputusan desain

1. Form tenang, latar hangat, dan tombol petrol mengikuti mockup POS yang disetujui; bukti visual berasal dari satu konteks produk yang berbeda.
2. Nominal tetap tersembunyi sebelum PIN benar; setiap keadaan memiliki tindakan atau penjelasan berikutnya.
3. Pada mobile panel informasi ditumpuk setelah tugas utama; pada desktop ditaruh di sisi kanan. Nilai sisa percobaan hanya ilustrasi: API 403 saat ini tidak menyediakan nilai itu.

## Keterbatasan

Kontrol dalam gambar dan tampilan layar individual adalah ilustrasi statis. Kontak HR belum ditentukan. API WhatsApp saat ini mengembalikan 503; mockup 429 menggambarkan kondisi setelah layanan tersedia, bukan kemampuan yang sudah siap. Render memakai Chrome/Playwright dari HTML, bukan gambar generatif, untuk menjaga ketepatan teks dan konsistensi antar layar. Review visual dilakukan pada sampel mobile dan desktop; belum ada pengujian aksesibilitas atau pengguna.
