# Review pencairan gaji

Halaman: `review.html`. Mockup HTML lokal dengan font Jakarta Sans yang sudah digunakan backoffice. Seluruh nama, nominal, status, referensi, dan rekening adalah ilustrasi; halaman tidak terhubung ke API atau penyedia pembayaran dan tidak menyimpan isian.

## Layar dan kondisi

| Layar                       | Tujuan                                                                     | Tautan lokal                                      |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Siap bayar                  | Memilih run terkunci yang belum lunas                                      | `review.html?view=runs&state=normal`              |
| Persetujuan                 | Memeriksa penerima, rekening, gaji utuh, biaya PT, dan orang kedua         | `review.html?view=approval&state=normal`          |
| Status karyawan             | Menindaklanjuti menunggu, berhasil, gagal, dan dibayar manual              | `review.html?view=status&state=normal`            |
| Pengaturan PT               | Memilih metode, rekening sumber, batas, dan kredensial khusus pencairan    | `review.html?view=settings&state=normal`          |
| Rekening sumber tidak aktif | Menolak pencairan sampai rekening aktif dipilih dan perubahan diverifikasi | `review.html?view=settings&state=inactive-source` |
| Duitku belum aktif          | Menjelaskan jalur manual dan syarat aktivasi per PT                        | `review.html?view=runs&state=duitku-off`          |
| Hasil belum pasti           | Menahan bayar ulang sampai hasil bank dibuktikan                           | `review.html?view=status&state=unknown`           |

Setiap layar mendukung `state=normal`, `empty`, `error`, dan `loading`, dipilih melalui kontrol “Kondisi review”. Alias `state=approval` membuka persetujuan; `state=source-inactive` membuka rekening sumber tidak aktif. Desktop dirancang untuk 1440 px dan mobile untuk 390 px; tabel berubah menjadi kartu vertikal di bawah 700 px.

## Tiga keputusan desain

1. Daftar run, persetujuan, hasil karyawan, dan konfigurasi dipisah menjadi empat tab agar satu layar mempunyai satu tugas utama. Pemeriksaan dua orang ditampilkan sebagai urutan bernama, dengan pembuat dan penyetuju berbeda.
2. Gaji utuh ditonjolkan terpisah dari biaya PT. Contoh empat karyawan menerima Rp21.500.000, biaya perkiraan Rp20.000, dan dana disiapkan Rp21.520.000. Tidak ada potongan biaya dari gaji. Biaya manual aktual mengikuti bank.
3. Kondisi berisiko memakai alasan tertulis dan aksi pemulihan. Rekening sumber nonaktif menolak pencairan, Duitku belum aktif mengarahkan ke manual, dan hasil belum pasti tidak menyediakan tombol bayar ulang. Status menggunakan teks, bukan warna saja.

## Keputusan founder yang sudah dipakai

- Pembuat pengajuan dan penyetuju adalah dua orang berbeda; konfirmasi transfer manual dilakukan orang selain pembuat dengan referensi, bukti, dan MFA. Tidak ada ambang nominal untuk melewati pemeriksaan ini.
- Transfer manual tidak memerlukan unduhan berkas bank saat rilis. Operator memeriksa nama di internet banking dan memasukkan referensi/bukti; format berkas bank menyusul setelah rilis.
- Batas contoh Rp50.000.000 per transfer dan Rp100.000.000 harian hanya ilustrasi konfigurasi; batas harian aktual perlu dipilih PT. Duitku tetap mati sampai diaktifkan setelah akun, deposit, dan sandbox siap.

## Verifikasi

Pemeriksaan render, screenshot desktop/mobile, dan `ghostex visual check` dijalankan oleh agent induk. Halaman ini hanya mockup; alur pembayaran, otorisasi, validasi server, MFA, penyedia, dan invariant uang tidak dapat dibuktikan oleh mockup dan harus diuji saat implementasi.

## Asumsi tampilan untuk gerbang founder

- Empat tab memisahkan pilih run, pemeriksaan, hasil, dan pengaturan. Founder meninjau apakah urutan ini sesuai cara kerja finance.
- Istilah run, payout, dan edge mengikuti brief; bahasa label dapat disederhanakan bila operator belum mengenalnya.
- Nominal batas per transfer dan harian adalah data contoh, bukan batas kebijakan yang sudah disetujui.

## Sumber dan arah desain

Brief `docs/briefs/669-designer-disbursement-finance-exceptions.md`, isi kartu `669-cards.txt`, desain payroll §7, standar UI tim, serta dua pola backoffice `account-role-mappings.html` dan `jurnal-outlet-5ac3.html`. Bukti pola lokal: observed, kuat untuk konsistensi; tidak memakai data riset pengguna atau referensi eksternal sebagai bukti.

Arah: permukaan solid hangat, aksen teal, Jakarta Sans lokal, kepadatan meja kerja finance. Pada 1440 tabel mendukung perbandingan; pada 390/320 baris menjadi kartu dan kontrol ditumpuk. Gerak dekoratif tidak digunakan. State tombol, error, dan fokus menjadi umpan balik utama. Membandingkan satu tabel besar dengan empat tab: tab dipilih agar pengaturan tidak bercampur dengan keputusan pencairan; biaya tambahannya adalah perpindahan layar.

`review.html` mandiri dan font tertanam untuk Ghostex. Sumber yang diedit adalah `review.js` dan `styles.css`; `heavy node design/mockups/payout/render.mjs` mengemas ulang HTML dan menghasilkan PNG kedua area serta `verification.json`. Data source memakai fixture tanpa koneksi jaringan, penyimpanan, atau transaksi.

## Bukti pemeriksaan

- Chrome headless: 72 kombinasi layar/kondisi/lebar (1440, 390, 320), tanpa overflow halaman atau exception JavaScript; 48 PNG desktop/mobile.
- Interaksi: nilai tidak tersedia, filter outlet dan tanggal 92 hari; rekening aktif lalu nonaktif; penolakan tetap saat pindah tab; Duitku mati; konteks PT; checkbox pemeriksaan; batas simulasi persetujuan; hasil belum pasti tanpa konfirmasi bayar manual.
- Review terpisah: tiga masalah navigasi/konteks/sumber diperbaiki. Teks utama mobile diperbesar dan outline kategori tidak terpotong.
- Format dan ESLint JavaScript diperiksa menggunakan alat yang sudah terpasang di worktree finance-exceptions, karena dependensi checkout induk tidak lengkap.

## Delivery Gate RYUX

| Area          | Hasil        | Bukti atau batas                                                                                       |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| Product       | PASS         | Brief dan kontrak lokal; bukti kuat untuk aturan yang ditampilkan                                      |
| UX            | PASS         | Tugas dipisah empat tab, pengaman tetap lintas navigasi                                                |
| UI            | PASS         | Arah backoffice tenang; tabel menjadi kartu                                                            |
| Design system | PASS         | Font dan pola backoffice dipakai ulang; tidak menambah pustaka                                         |
| Accessibility | NOT VERIFIED | Fokus/label/native dialog dan teks inti mobile diperiksa; axe dan audit pembaca layar belum dijalankan |
| Responsive    | PASS         | 1440/390/320 tanpa overflow halaman; tab bergeser di wadahnya sendiri                                  |
| Edge cases    | PASS         | Normal, kosong, error, loading, sumber nonaktif, Duitku mati, hasil belum pasti                        |
| Code quality  | PASS         | Format, sintaks dan ESLint JavaScript mockup                                                           |
| Visual QA     | PASS         | Screenshot serta Ghostex check desktop/mobile; tidak menilai UI production                             |
| Anti-slop     | PASS         | Data ilustrasi berlabel, aksi simulasi, warna status disertai teks, tanpa ornamen dekoratif            |
| Final         | NOT VERIFIED | Mockup siap gerbang; aksesibilitas lengkap dan integrasi uang milik tahap implementasi                 |

Tidak menjalankan build, API, MFA, uji otorisasi, sandbox Duitku, Lighthouse, atau invariant pembayaran backend. Mockup tidak membuktikan bahwa uang produksi aman; implementasi perlu test terpisah sebelum rilis. Tidak ada file aplikasi, migrasi, atau dokumen di luar scope yang diubah.
