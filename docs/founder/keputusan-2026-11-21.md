# Keputusan yang ditunggu dari founder (21 Nov 2026)

Menggantikan `keputusan-2026-11-20.md`. Selama belum dijawab, sistem memakai aturan paling aman: tidak membayar lebih, tidak menghitung laba lebih tinggi, tidak menjalankan fitur yang belum pasti.

Cara menjawab: cukup tulis nomor dan "setuju usulan" atau pilihan lain.

## A. Perlu dijawab sebelum rilis 1

1. **Rilis tanpa GoFood/Grab/Shopee dan mesin EDC bank.**
   Usulan: ya. Kasir mencatat pembayaran kartu secara manual. Integrasi menyusul saat akun mitra dan bank siap.
2. **Refund penjualan kasir offline.**
   Penjualan yang dibuat saat kasir offline (server outlet) belum bisa direfund dari pusat di rilis 1. Bila kasir offline tetap mencatat refund, refund itu muncul di daftar "perlu dicek" bagian keuangan dan tidak bisa dibayar dua kali.
   Usulan: terima untuk rilis 1. Refund penjualan offline dilakukan manajer secara tunai lalu dicek keuangan. Refund dari pusat menyusul.
3. **Tutup hari saat internet outlet putus.**
   Bila server outlet tidak terhubung lebih dari 15 menit, manajer boleh menutup hari dari aplikasi pusat. Pesanan yang masuk sesudahnya tetap tercatat di tanggalnya sendiri, tetapi belum diberi tanda "terlambat".
   Usulan: terima. Tanda "terlambat" menyusul.
4. **Absen staf tanpa paket data.**
   Layar absen di perangkat outlet belum ada. Staf yang tidak bisa absen dari HP-nya dikoreksi manual oleh supervisor.
   Usulan: terima untuk rilis 1.
5. **Gaji dibebankan ke outlet mana.**
   Usulan: ke outlet tempat karyawan terdaftar. Staf pusat atau staf bersama dibagi sesuai porsi penjualan. Selama belum dijawab, bagi hasil per outlet ditahan.
6. **Gaji akhir karyawan keluar: uang ganti cuti dan THR.**
   Gaji terakhir, BPJS, dan PPh21 sudah otomatis. Uang ganti cuti dan THR karyawan keluar dihitung manual oleh HR.
   Usulan: tetap manual di rilis 1.
7. **Voucher permintaan maaf.**
   Sekarang semua voucher maaf tanpa laporan item gagal harus disetujui atasan.
   Usulan: tetap begitu. Pilihan lain: sebutkan batas nominal yang boleh tanpa persetujuan.
8. **Refund pembayaran Duitku.**
   Usulan: rilis 1 lewat transfer manual dengan persetujuan manajer dan catatan di sistem. API refund menyusul.
9. **Refund saat jalur refund DOIT dimatikan.**
   Usulan: refund tidak boleh dicatat tanpa bukti dari DOIT. Paling aman, tidak ada refund ganda.
10. **Login dan notifikasi pelanggan: WhatsApp, email, atau keduanya.**
    Butuh minimal satu. WhatsApp perlu akun Meta Business terverifikasi atau Kirimdev, plus nomor khusus. Email perlu akun pengirim email.
    Usulan: email dulu (lebih cepat siap), WhatsApp menyusul.
11. **SMS.** Usulan: tidak perlu.
12. **Kurir pengiriman.** Usulan: tidak di rilis 1.
13. **Pemantau error (Sentry atau sejenis).** Usulan: ya, paket gratis cukup. Founder membuat akunnya.
14. **Fitur yang belum siap: reservasi, Tanya AI di layar dapur, menu fasilitas di perangkat bersama.**
    Usulan: disembunyikan di rilis 1.

## B. Perlu dilihat founder

15. Layar fasilitas, pembayaran, Wi-Fi, HRIS (desain v2).
16. Mockup pemilih QRIS/EDC saat menagih tukar menu di kasir.
17. Katalog 105 laporan standar. Di rilis 1, laporan keuangan, absen, gaji, dan kinerja tampil "Segera hadir" sampai datanya tersambung.
18. Dialog koreksi PTKP, dialog batal persetujuan bagi hasil, banner payout beku. Screenshot di `docs/review/img/`.

## C. Akun dan kunci (di akhir, tidak lewat chat)

- DOIT dan Duitku: founder sudah siap. Diisi di akhir ke `deploy/single-vm/runtime.env`. Tim hanya memeriksa nama kuncinya lengkap.
- Kunci sandbox DOIT dan Duitku untuk uji coba sebelum rilis, bila ada. Mempercepat uji pembayaran nyata.
- Akun email pengirim atau WhatsApp (sesuai jawaban no. 10), dan akun pemantau error (no. 13).

## D. Pertanyaan baru (21 Nov, sesudah "setuju semua")

19. **Tutup buku bulanan saat ada batch produksi yang tertahan** (diperbarui 21 Nov siang).
    Batch produksi ditahan bila catatan bahan yang dipakai tidak pernah sampai dari server outlet ke pusat. Selama ada batch tertahan, tutup buku bulan itu ditolak, supaya laporan tidak salah.
    Temuan tim: tombol "kirim ulang" dari pusat tidak bisa menolong, karena catatan yang hilang tertahan di server outlet. Jalur pemulihan dari outlet butuh desain sendiri dan baru siap sesudah rilis 1. Kalau tetap ditolak tanpa jalan keluar, tutup buku bulan itu bisa tertahan terus.
    Usulan baru: pemilik atau finance manager boleh menutup buku dengan alasan tertulis. Sistem menyimpan siapa yang menutup, alasannya, dan daftar batch yang tertahan. Batch itu dibukukan di bulan berikutnya begitu datanya lengkap. Tidak ada uang yang dibayarkan, jadi tidak ada risiko bayar lebih.
    Pilihan lain: tetap ditolak sampai jalur pemulihan outlet siap (sesudah rilis 1).
    **Jawaban founder (21 Nov): "Boleh dengan alasan tertulis."** Dikerjakan di kartu 1263.

20. **Layar refund manual Duitku (1259) dan tutup buku dengan alasan tertulis (1263).** **Jawaban founder (25 Nov): "Setuju keduanya."** Bagian B butir lain tidak termasuk jawaban ini.

21. **Bagian B nomor 15 sampai 18.** **Jawaban founder (25 Nov): "kerjakan sesuai rekomendasi kamu."** Dikerjakan di kartu 1267: 15 audit lalu perbaiki, 16 mockup dan layar QRIS/EDC, 17 dan 18 diterima bila audit tidak menemukan masalah berat. Tiga tugas rilis (dry-run PPh21, latihan deploy, review Caddy) di kartu 1265. Tidak termasuk izin merge ke main atau deploy. **Hasil (25 Nov):** masuk milestone/m1 (c52680ee0). 15: temuan audit dibetulkan. 16: layar QRIS/EDC jadi tetapi terkunci sampai backend siap (legend-f1mmf). 17 dan 18: masalah yang ditemukan audit dibetulkan (status "Segera hadir" dari satu sumber, tanggal PTKP di dialog, dialog buka-beku); laporan keuangan, absen, gaji, kinerja tetap "Segera hadir". Latihan deploy dan review Caddy lulus; PPh21 tinggal dijalankan di staging (wxvt9).

22. **Tambahan scope rilis 1.** **Jawaban founder (25 Nov malam):** struk wajib tercetak lewat printer edge; refund DOIT dibiarkan mati karena awal memakai Duitku; EDC otomatis, VA/e-wallet/kartu online, dan laporan keuangan/absen/gaji/kinerja wajib ada di rilis 1. Rincian kerja: `docs/briefs/1269-scope-tambahan.md`.

23. **POS saat internet putus.** **Jawaban founder (25 Nov malam): "Pos wajib bisa offline".** EDG-01 (4 jam) dan EDC-05 wajib di rilis 1.

24. **Sandbox Duitku.** **Jawaban founder (25 Nov malam):** akun sandbox baru bisa dipakai sesudah ada domain dan deploy; kode dibangun dulu sesuai dokumentasi. Metode tetap terkunci sampai bukti sandbox (C1) di staging lulus.

25. **Tiket, poin, voucher, dan DP di kasir.** **Jawaban founder (25 Nov malam): "Wajib rilis 1".** Tiket juga saat offline (PRD FAC-03).

26. **Kamar mandi berbayar (shower room) ditunda.** **Jawaban founder (25 Nov malam):** "tidak dibuka pada saat awal rilis". Membatalkan bagian tiket di keputusan 25 untuk rilis 1; poin, voucher, dan DP di kasir tetap wajib. Pertanyaan tiket offline tanpa member, paket/langganan shower, dan smart lock ikut ditunda. Server wajib menolak penjualannya (kartu F0), bukan hanya menu disembunyikan. Wi-Fi tamu dan kebijakan WFC tetap.

27. **WFC berbayar (day pass, reservasi kursi, langganan).** **Jawaban founder (25 Nov malam):** "wajib rilis 1 karena ini berkaitan dengan program marketing". Hanya shower yang ditutup (keputusan 26); kartu F0 menutup `facilities.type = shower` saja.

28. **Aturan WFC yang menjaga omset.** **Jawaban founder (26 Nov):** setuju arah usulan CTO (kredit makan/minum hangus hari itu, jenis jam sepi dan sepanjang hari, kuota kursi per jam, bulanan hanya jam sepi, tidak datang 30 menit kursi dijual lagi, minimum belanja tetap untuk tamu tanpa pass, harga terendah dijaga, laporan mingguan). Lima angka bisnis (kursi total/WFC, jam buka, biaya tetap, target omset/laba/okupansi, belanja per orang dan modal bahan) tidak diisi sekarang: "nantinya bisa di set di config atau bisa di set lewat agentic menentukan harga ataupun skemanya". Pengaman CTO (bukan ucapan founder): AI hanya mengusulkan; orang berwenang menyetujui sebelum harga atau skema berlaku; perubahan tidak menyentuh pass yang sudah terjual; tanpa angka lengkap penjualan tetap mati.

29. **Server outlet (edge) mati.** **Jawaban founder (26 Nov): "bagusnya cadangannya di cloud karena cloud uptimenya bagus jarang down".** Dibangun jendela failover sesuai `docs/design/edge-cloud-failover.md` (keputusan 9 Nov tetap: manajer dan supervisor shift boleh membuka, hitung laci wajib saat pindah dan kembali, struk QR di layar, tutup hari dari data cloud boleh, nomor seri `F` diterima). Mini PC cadangan (standby, F11b/c/e, legend-b3k) tidak wajib rilis 1, dipindah ke sesudah rilis. Batas: edge mati dan internet putus bersamaan = tidak bisa jual lewat sistem (catat manual di runbook).

30. **Keputusan lain diserahkan ke CTO.** **Jawaban founder (26 Nov): "lainnya kamu putuskan ... prinsipnya kita harus untung jangan merugikan cafe dan harus sesuai standar industri cafe dan resto di indonesia".** Keputusan CTO:
    - Mockup WFC (termasuk "Check-in tanpa kursi"): disetujui apa adanya.
    - Usulan AI harga WFC (W13): sesudah rilis. Rilis 1 memakai angka config yang diisi manusia; tanpa angka lengkap penjualan WFC mati.
    - Captain di meja bayar di muka: tetap ditolak, tamu ke kasir (sesuai PRD, dapur tidak masak sebelum dibayar).
