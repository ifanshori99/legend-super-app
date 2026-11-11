# Akses dukungan — mockup review

Mockup statis untuk owner; data orang, tanggal, alasan, dan organisasi adalah contoh. HTML tidak terhubung ke akun, akses, atau data sungguhan. Layar tersedia pada lebar 1280 dan 390 px, dengan kondisi permintaan, kosong, disetujui/aktif, ditolak, kedaluwarsa, offline, serta konfirmasi cabut. Sumber gambar: `support-access.html`; render: `heavy node design/mockups/platform/render.mjs` dari root repo.

## Keputusan desain

1. Peminta, alasan, cakupan baca dan ubah, durasi, serta batas keputusan ditampilkan sebelum tombol persetujuan; akses perubahan dijelaskan dalam bahasa sehari-hari.
2. Owner dan verifikasi dua langkah disebut sebelum keputusan; permintaan kedaluwarsa setelah 24 jam, sedangkan offline tidak memungkinkan keputusan sampai status terbaru dimuat.
3. Akses yang sudah diberikan menampilkan waktu akhir dan aksi cabut dengan konfirmasi; penolakan dan kedaluwarsa menjelaskan bahwa akses tidak diberikan.

## Asumsi dan batas

- Contoh memakai 30 menit dari pilihan 15 atau 30 menit untuk permintaan baca-tulis pada implementasi backend `788efa5f`; data contoh bukan kebijakan untuk seluruh jenis akses. Persetujuan membuat grant segera, sehingga contoh berakhir 30 menit setelah persetujuan.
- Cakupan pada contoh menggambarkan akses baca-tulis tenant; istilah dan identitas peminta perlu mengikuti data aktual. Contoh tidak menjanjikan pembatasan per modul atau outlet.
- Tombol dan status ini gambar statis. Konfirmasi pencabutan ditampilkan untuk kejelasan; alur dan perizinan aktual perlu diselaraskan saat implementasi. Sesi impersonasi tidak boleh mengambil keputusan.
- Referensi: `docs/briefs/483-mockups-pos-ai.md`, `legend-8r77t`, `DESIGN.md`, PRD bagian Support Access, dan backend `788efa5f`. Visual memakai tema Padat & Presisi untuk owner.
