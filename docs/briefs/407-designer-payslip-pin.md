# Brief: designer — mockup layar PIN slip gaji (legend-ilzrj)

## Peran
Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`, lalu ikuti. Lihat `design/` untuk gaya mockup Legend yang sudah disetujui dan `design/REFERENCES.md` bila ada.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (baca saja kode; tulis mockup di `design/mockups/payslip-pin/`).

## Tujuan
`bd show legend-ilzrj`. Keputusan founder: PIN dibuat karyawan sendiri; HR hanya reset, tidak pernah melihat atau mengatur PIN. Kontrak API di cabang `ws/hris-pii-pin` (cari `payslip` di `packages/shared` dan `apps/api/src/routes`): daftar slip, buka slip dengan PIN, status/set/ubah PIN, reset oleh HR, reset lewat kode WhatsApp (belum tersedia: 503), error 403 salah PIN, 423 terkunci 15 menit setelah 5 salah, 409 PIN belum dibuat, 429 terlalu banyak kode.

Layar (karyawan, mobile 390 dulu, juga 1280): buat PIN pertama kali, masukkan PIN untuk buka slip, salah PIN (sisa percobaan), terkunci, lupa PIN (minta kode WhatsApp atau hubungi HR), ubah PIN. Layar HR: tombol reset PIN karyawan dengan konfirmasi. Keadaan kosong, memuat, error.

## Hasil
PNG per layar di 390 dan 1280 + satu HTML ringkas untuk review founder. Lapor path berkas dan pertanyaan bisnis yang perlu founder.
