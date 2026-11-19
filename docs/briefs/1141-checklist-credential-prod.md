# 1141 Checklist credential production integrasi eksternal
Peran: tech-writer (baca ~/.agents/team/roles/tech-writer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kelompok integrasi: pembayaran Duitku/DOIT, kurir KirimDev, EDC, marketplace GoFood/ShopeeFood/GrabFood, lainnya seperti email/SMS/WA/AI/storage).
Kerja di folder utama, tanpa worktree, hanya dokumen. Jangan baca `.env`, `.env.local`, atau env production; nama key dari `.env.example`, `apps/api/src/config/env.ts`, dan kode integrasi.

Tujuan: founder tinggal memasang credential production di akhir. Tulis `docs/production-credentials.md`, bahasa Indonesia sehari-hari, per integrasi:
- Nama layanan, dipakai untuk apa di Legend.
- Credential yang dibutuhkan (nama key env persis ATAU layar admin Legend tempat mengisinya, per tenant/brand/outlet bila begitu), mana yang rahasia.
- Dari mana founder mendapatkannya (dashboard penyedia, menu kira-kira), URL webhook/callback yang harus didaftarkan di penyedia (pola path dari route API), IP whitelist bila ada.
- Cara uji aman sesudah dipasang (endpoint health/sandbox toggle/tes koneksi yang sudah ada di kode).
- Status kesiapan kode: siap, sebagian (sebut bead), atau belum ada.
Akhiri dengan urutan pemasangan yang disarankan dan daftar celah (integrasi yang disebut founder tapi kodenya belum ada: buat bead `bd create` P1/P2).

Bukti: setiap key/route yang ditulis dirujuk berkas:baris. Prettier pada berkas itu. Commit dokumen di cabang aktif folder utama (jangan push main).
Laporan: path dokumen, ringkasan per integrasi (siap/sebagian/belum), bead baru. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
