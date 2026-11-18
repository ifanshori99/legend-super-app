# 1045 Kebersihan tipe dan test (Codex S)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex high. Codex tidak menjalankan bd; isi kartu di bawah. Base origin/milestone/m1.

## legend-izy5l
◐ legend-izy5l · Akar TS2769: helper tipe ID bermerek untuk Drizzle where/inArray/sql   [P1 · IN_PROGRESS]
DESCRIPTION
Retro 41: TS2769 berulang di 7 berkas dari 5+ thread; typecheck gagal 20/70 
job (28,6%) dan tsc adalah proses terbesar di 24/24 sampel RAM merah.       
Periksa pola Drizzle where/inArray/sql dengan ID bermerek ($brand<...>, mis.
TenantId), buat satu helper tipe, ganti pemakaian di berkas yang terkena,   
dan tulis pola itu di docs/backend.md. Tingkat S kecuali menyentuh query    
uang/akses.                                                                 

## legend-ug14o
◐ legend-ug14o [BUG] · e2e legend-mzg.mock.spec.ts: 3 test gagal di milestone/m1 (ACC-01, ACC-03, recurring)   [P2 · IN_PROGRESS]
DESCRIPTION
Terbukti di base origin/milestone/m1 5cbe2a1e (13 Nov, thread U5b): ACC-01  
dan recurring timeout di choose() combobox .nth(n) (indeks bergeser sejak   
kolom outlet per baris 5ac3); ACC-01 juga mengharapkan 'Simpan draf'        
disabled padahal selalu aktif; ACC-03 heading 'Tagihan internet November    
2026 (koreksi)' tidak ditemukan. Perbarui spec ke UI sekarang.              

Batas: izy5l jangan ubah berkas query uang (refund/payment/payout/payroll/kas) atau akses/RLS: lewati dan sebut di laporan. ug14o: ubah spec e2e saja agar cocok dengan UI sekarang, jangan ubah kode produk; bila UI terlihat salah (bukan spec), lapor, jangan ubah. Tanpa migrasi.
Bukti: typecheck API + web lewat heavy, e2e mock terarah lewat heavy --browser untuk spec yang diubah, prettier/eslint. Commit, push tanpa force. Laporan sekali di akhir: perubahan per kartu, bukti, SHA.
