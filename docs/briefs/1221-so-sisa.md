# 1221 Second opinion area sisa SO 1216 (read-only)

Baca kode di worktree `/Users/ifanshori99/Projects/legend super app/legend-int-batch101` (cabang int/batch101, JANGAN ubah berkas apa pun di sana, full run sedang jalan; jangan jalankan test). Prinsip founder: jangan sampai rugi (tidak ada pihak dibayar lebih, outlet tidak rugi, angka pajak benar). Laporan lama sebagai konteks: `docs/qa/second-opinion-1216.md` di checkout utama.

Cari bug nyata saja (file:baris, skenario konkret input -> angka salah, prioritas P1/P2/P3). Jangan laporkan gaya. Batas 35 tool call. Tulis laporan ke berkas yang disebut di prompt (checkout utama `docs/qa/`), lalu ringkas temuan di balasan.

## Area A (payroll/pajak)
Coretax bukti potong A1 (angka setahun, karyawan masuk/keluar tengah tahun), finalisasi rapel, piutang PPh21 (lebih potong), pajak service charge, seed TER (tarif/kategori PTKP), PIN slip gaji (akses), export payroll (data pribadi, angka sama dengan slip).

## Area B (CRM/inventori/akuntansi)
Batas voucher permintaan maaf (siapa bisa terbit, batas nilai/jumlah, penyalahgunaan), refund poin lama (poin kembali lebih dari yang dipakai, poin kedaluwarsa), receipt dengan biaya 0 ke saldo negatif (sesudah 1214), tanggal selesai distribusi bagi hasil di periode tertutup.
