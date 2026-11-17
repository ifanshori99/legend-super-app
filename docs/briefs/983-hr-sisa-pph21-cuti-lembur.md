# 983 HR sisa: backfill piutang PPh21, akses lampiran cuti, rapel lembur

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang, akses, migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/dd932307` (payroll 955+972, belum di m1). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0555-0559 (nomor kerja; dd932307 memegang 0461, 0515).

Kartu (`bd show <id>`; claim dulu):
- legend-i848k: piutang karyawan yang dibuat sebelum open item 972 tidak punya item. Backfill item (migrasi data, idempoten, cek dulu data yang bentrok); nilai item = sisa piutang sebenarnya, tidak boleh lebih.
- legend-qu04u: `hris-leave-request.service.ts:533-541` `presentRequest`: cabang pemilik memakai `access.own.id == row.employeeId` tanpa cek izin/tenant. Perbaiki supaya lampiran cuti hanya terbaca pemilik sah atau peran ber-izin di tenant yang sama; test lintas tenant dan lintas karyawan.
- legend-72nod: rapel hanya komponen tetap; koreksi lembur periode beku ditahan untuk review manual. Buat alur otomatis terbatas: selisih lembur yang disetujui masuk rapel periode berjalan, tidak pernah dobel dengan bayaran lama, aturan bayar terbatas tetap (selisih negatif jadi potongan bertahap, bukan diabaikan).
Konteks: keputusan CTO 955/972 (offboarding 409 saat potongan pending; pencairan pinjaman ditolak selama offboarding open/revoked/completed) dan founder Q22 (aturan pencairan gaji 947 tetap).

Jangan sentuh: refund/recon (980), ulasan/MCP (981), charge tukar menu (982), aturan pencairan gaji 947.

Jangan sampai rugi: test bukti (1) backfill tidak membuat piutang lebih besar dari sisa dan aman dijalankan dua kali, (2) rapel lembur tidak membayar dua kali jam yang sama, termasuk koreksi berulang, (3) karyawan yang sudah offboarding tidak menerima rapel di luar aturan, (4) lampiran cuti tidak bocor antar karyawan/tenant. Bila ragu: tahan pembayaran untuk review manual.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (#9): lint, typecheck API, test terarah grup payroll/hris-leave, `db:generate` kosong, prettier. Satu token heavy per thread.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
