# Triase bead terbuka P0-P2 untuk rilis tahap 1 Cafe Legend (20 Nov 2026)

Scope tahap 1: POS, KDS, inventori, akuntansi, HRIS/payroll, loyalty, pembayaran Duitku + DOIT. Di luar: GoFood/Grab/Shopee, EDC bank, refund DOIT, verifikasi email, CSP nonce. Dasar: judul dan isi singkat bead; bukan audit kode. Cabang kerja ini (ux/customer-order-benchmark) tidak memuat backend, jadi status "sudah dibangun?" bead lama tidak bisa dicek di sini.

Catatan: bead WS-xx BE bertanggal 1 Nov (payroll, jurnal otomatis, penerimaan barang) tidak pernah diperbarui. Kodenya mungkin sudah ada di cabang lain. Bila terbukti sudah memenuhi kriteria, tutup; bila tidak, tetap BLOK.

## Ringkasan

| Kategori | Jumlah |
|---|---|
| BLOK | 27 |
| SESUDAH | 90 |
| KEPUTUSAN FOUNDER | 13 |
| Total | 130 |

## Daftar BLOK (urut risiko, tertinggi dulu)

1. `legend-3tyl1` Refund echo skip: bandingkan dengan jumlah ditagih provider, bukan intent (SO 1200 P3 - Refund yang jumlah ditagih penyedia lebih besar dari intent bisa dibayar dua kali (bead sendiri bilang sebelum rilis).
2. `legend-ecr16` Rekonsiliasi refund edge lama yang belum pernah tersinkron ke pusat (sebelum batas Q6 - Refund edge lama yang tak pernah sinkron membuat pusat tidak tahu dan batas kumulatif refund bisa terlewati (bayar lebih).
3. `legend-t1ufu` SO 1173 architect P2: re-raise of known evidence_read_locked flag must not be best-ef - Satu flag gagal dalam chunk payout gaji membatalkan hold baru, sehingga slip bisa terbayar padahal bukti terkunci.
4. `legend-tomda` Receipt biaya 0 ke stok negatif menurunkan HPP; bergantung urutan baris (SO 1221 B3) - Receipt biaya 0 ke stok negatif menurunkan HPP sehingga laba dan bagi hasil terlihat naik.
5. `legend-wxvt9` Gerbang rilis: dry-run backfill piutang PPh21 di staging - Backfill piutang PPh21 harus di-dry-run di staging sebelum produksi, kalau tidak PPh21/piutang karyawan bisa salah.
6. `legend-l3bq` WS-10 BE: PPh 21 TER engine (PP 58/2023): monthly TER, final-period recalculation, PT - Mesin PPh21 TER (inti pajak gaji) masih tercatat terbuka; pajak gaji salah jika belum lengkap.
7. `legend-j2l2` WS-10 BE: Payroll engine: components, BPJS (versioned rates/caps/shares), THR by tenu - Mesin payroll (BPJS, THR, kasbon) masih tercatat terbuka; gaji salah jika belum lengkap.
8. `legend-07eg` WS-10 BE: Payroll run lifecycle: side-effect-free simulation, 2-level approval, lock, - Siklus payroll run (simulasi, approval 2 level, kunci, batal) masih tercatat terbuka; alur gaji utama.
9. `legend-arj.5` WS-10 BE: final settlement amounts from payroll engine (prorated salary, THR, BPJS, l - Angka settlement karyawan keluar (prorata, THR, BPJS, cuti) masih terbuka; salah hitung = bayar lebih/kurang.
10. `legend-29vw` WS-07 BE: Auto-journals: COGS, purchases/AP, production, waste, stock adjustments - Jurnal otomatis HPP/pembelian/produksi/waste masih terbuka; stok dan HPP di buku bisa salah.
11. `legend-905j` WS-07 BE: Auto-journals: payroll, loyalty point liability, dividends, depreciation - Jurnal otomatis payroll, kewajiban poin loyalty, dividen, penyusutan masih terbuka; buku akuntansi tidak lengkap.
12. `legend-316` WS-06 BE: Goods receipt (partial, QC) + supplier invoice + 3-way match + supplier pay - Penerimaan barang, faktur supplier, 3-way match, dan bayar supplier masih terbuka; stok dan utang bisa salah.
13. `legend-1yig6` Sandbox proof DOIT/Duitku: QRIS status after expiry, min expiryPeriod - Belum terbukti di sandbox: QRIS kedaluwarsa masih bisa dibayar atau tidak; risiko uang masuk tanpa pesanan.
14. `legend-7tqe8` Gerbang rilis: cek domain paymentUrl dan field kartu (VC) Duitku di sandbox sebelum e - Host paymentUrl dan field kartu Duitku belum dicoba di sandbox; e-wallet/kartu tamu tidak boleh dinyalakan sebelum diuji.
15. `legend-astv2` Display U1: lift DP QRIS hold, cashier cancel waiting state, pairing screen - Angkat hold DP QRIS dan status batal kasir di layar pelanggan; alur QRIS DP bisa menggantung.
16. `legend-du7t5` UI koreksi PTKP karyawan (HR) untuk endpoint PUT /api/hris/employees/:id/ptkp (1223) - HR tidak punya layar koreksi PTKP; PTKP salah berarti PPh21 salah dan tak bisa dibetulkan tanpa API.
17. `legend-ofu02` Cek baris missing lama (source_transaction_id NULL) di staging sebelum rilis; isi kol - Gerbang rilis: baris rekonsiliasi lama tanpa source_transaction_id harus dicek/diisi sebelum rilis.
18. `legend-4t4g7` Gerbang rilis: cek baris reservasi legacy tanpa deposit_payment_link_id di production - Gerbang rilis: baris reservasi legacy tanpa deposit_payment_link_id di production bisa menahan deposit tanpa batas.
19. `legend-j7018` Cek postCompletionJournal distribusi bagi hasil di periode tertutup (SO 1221 B4) - Jurnal selesai bagi hasil memakai tanggal bayar terakhir, perlakuan periode tertutup belum diverifikasi (buku bisa tertulis di periode salah).
20. `legend-w8cwg` Drift schema: db:generate di basis ws/1096 (a93468ca8, turunan ghostex/45769078) meng - Drift skema: db:generate menghasilkan migrasi tabel access_ticket_credential yang tak ada di drizzle/; migrasi deploy bisa gagal.
21. `legend-k0i8` WS-04 BE: offline POS order sync from edge to cloud — late adjustment to next open bu - Sinkron order POS offline dari edge ke cloud (penyesuaian terlambat ke hari buka berikutnya) masih terbuka; penjualan/pajak harian bisa salah hari.
22. `legend-xhl5j` Promo refund: voucher kembali saat diskon manual ditumpuk (1219 P3) - Voucher promo kembali padahal diskon manual ditumpuk; tamu untung kecil dan outlet rugi (aturan jangan sampai rugi).
23. `legend-gdjpu` SO 1111 P2: ACK void edge bisa mendahului ingest sukses -> run struk ditolak tanpa pe - ACK void edge bisa mendahului ingest sukses sehingga run struk ditolak tanpa pemulihan otomatis; sinkron kasir tersangkut.
24. `legend-94xqo` Satukan env storage: STORAGE_S3_* vs OBJECT_STORAGE_* (deploy rawan salah) - Dua set env storage (STORAGE_S3_* dan OBJECT_STORAGE_*) membuat deploy rawan salah dan fitur dokumen gagal; bead sendiri minta sebelum rilis.
25. `legend-x73li` WS-11 sambung FE laporan dan dasbor ke API asli - Layar laporan/dasbor belum disambung ke API asli; angka palsu bisa tampil ke owner.
26. `legend-tvkuz` WS-10 C8: UI layar absen outlet di edge (QR + PIN + selfie kamera) - UI absen outlet di edge (QR+PIN+selfie) belum ada; tanpa absen, payroll tidak punya data hadir.
27. `legend-0orff` WS-01 FE: panel Super Admin gateway pembayaran platform (nyala/mati, bawaan, jendela  - Panel Super Admin gateway pembayaran (nyala/mati, bawaan, jendela webhook) belum ada; Duitku/DOIT tak bisa diatur aman tanpa SQL.

## Keputusan founder

- `legend-2ggcc` SMS (OTP/notifikasi): tidak ada env maupun kode; putuskan perlu atau cukup WhatsApp/e - Putuskan apakah SMS dibutuhkan atau WhatsApp/email cukup.
- `legend-qgdp6` Kurir/pengiriman: tidak ada kode (KirimDev hanya WhatsApp); founder konfirmasi perlu  - Founder konfirmasi apakah kurir/pengiriman perlu dan pilih penyedianya.
- `legend-mtbq9` WS-05 BE: refund Duitku (API refund atau runbook payout manual) - Refund Duitku: pilih API refund atau runbook payout manual (keputusan bisnis dan uang).
- `legend-31fi` WS-11: owner sign-off on the proposed 105-report standard catalog - Owner harus menandatangani katalog 105 laporan standar.
- `legend-5c0a` Design v2: review facility, payment, Wi-Fi, HRIS screens - Founder harus review layar facility, payment, Wi-Fi, HRIS.
- `legend-ff393` 1012 keputusan produk: layar reservasi, Tanya AI KDS, _ops/fasilitas di perangkat ber - Keputusan produk: reservasi, Tanya AI KDS, fasilitas di perangkat bersama jadi POS atau disembunyikan.
- `legend-saov` WS-05 EXT: DOIT sandbox + live credentials and KYC (PT Sultan Solusi Nusantara) - Kredensial DOIT sandbox+live dan KYC adalah akun production milik founder.
- `legend-wor9` WS-01 EXT: WhatsApp Cloud API: verified Meta Business, dedicated number 'Legend', web - Founder putuskan apakah WhatsApp Cloud API (Meta Business verified) ikut rilis 1.
- `legend-axmob` Kirimdev produksi: akun, nomor, langganan webhook, secret, uji langsung - Akun, nomor, dan secret Kirimdev production butuh founder; ikut rilis 1 atau tidak.
- `legend-kpg76` WhatsApp: bukti kepemilikan nomor sebelum aktif untuk login - Bukti kepemilikan nomor WhatsApp untuk login bergantung keputusan WA rilis 1.
- `legend-17az7` Pemantau error production (Sentry atau sejenis): belum ada env maupun kode - Pilih dan sediakan akun pemantau error production (Sentry atau sejenis).
- `legend-t93l8` POS: pemilih QRIS/EDC untuk tagih charge tukar menu di layar kasir (mockup dulu, gerb - Mockup pemilih QRIS/EDC tukar menu butuh review founder dulu.
- `legend-h6k7c` Refund flag mati: refund dengan jejak penyedia yang macet tidak bisa dicatat manual ( - Butuh keputusan CTO/founder: boleh lewati lookup saat flag refund DOIT mati.

## Tabel lengkap

| id | P | judul singkat | kategori | alasan |
|---|---|---|---|---|
| legend-9tzc | P0 | WS-08 EXT: GoFood / GrabFood / ShopeeFood partner integration access | SESUDAH | GoFood/Grab/Shopee di luar rilis 1. |
| legend-cyu | P0 | WS-00: Fondasi Bersama (kontrak, RLS, event/outbox, CI, deploy) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-mooi | P0 | WS-02 EXT: EDC ECR integration specs + test terminals from >=2 banks | SESUDAH | Integrasi EDC bank di luar rilis 1. |
| legend-saov | P0 | WS-05 EXT: DOIT sandbox + live credentials and KYC (PT Sultan Solusi Nusantara) | KEPUTUSAN FOUNDER | Kredensial DOIT sandbox+live dan KYC adalah akun production milik founder. |
| legend-wor9 | P0 | WS-01 EXT: WhatsApp Cloud API: verified Meta Business, dedicated number 'Legend', web | KEPUTUSAN FOUNDER | Founder putuskan apakah WhatsApp Cloud API (Meta Business verified) ikut rilis 1. |
| legend-wwuc | P0 | WS-05 EXT: Transactional email provider + SPF/DKIM/DMARC on tenant domain | SESUDAH | Provider email belum ada; verifikasi email di luar rilis 1. |
| legend-08f | P1 | WS-08: Pelanggan, Loyalty, CRM, Reservasi, Ojol & Website (F20-F24) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-0pn | P1 | WS-05: Pembayaran, EDC, Pajak & Notifikasi (F13, F14, F15) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-1nb85 | P1 | Saklar refund DOIT nyala kembali membuka F1-F3/F6 (ronde 10): rancang ulang sebelum d | SESUDAH | Refund DOIT mati di rilis 1; desain ulang sebelum dinyalakan. |
| legend-2lp | P1 | WS-02: Edge Node, Perangkat, Print, EDC, Wi-Fi & Lock Agent (F5, F25) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-39d | P1 | WS-12: Tanya AI & MCP (F38, F39, F40) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-3a6 | P1 | WS-06: Inventori, Resep & Purchasing (F16, F17, F18) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-3pf | P1 | WS-13: QA, Keamanan & Integrasi (lintas modul) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-4ip | P1 | WS-03: Menu, Meja & QR Order (F8, F9, F10) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-5c0a | P1 | Design v2: review facility, payment, Wi-Fi, HRIS screens | KEPUTUSAN FOUNDER | Founder harus review layar facility, payment, Wi-Fi, HRIS. |
| legend-7tqe8 | P1 | Gerbang rilis: cek domain paymentUrl dan field kartu (VC) Duitku di sandbox sebelum e | BLOK | Host paymentUrl dan field kartu Duitku belum dicoba di sandbox; e-wallet/kartu tamu tidak boleh dinyalakan sebelum diuji. |
| legend-8a0 | P1 | WS-07: Akuntansi & Bagi Hasil (F19, F37) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-arj | P1 | WS-10: HRIS & Payroll (F26-F33) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-astv2 | P1 | Display U1: lift DP QRIS hold, cashier cancel waiting state, pairing screen | BLOK | Angkat hold DP QRIS dan status batal kasir di layar pelanggan; alur QRIS DP bisa menggantung. |
| legend-du7t5 | P1 | UI koreksi PTKP karyawan (HR) untuk endpoint PUT /api/hris/employees/:id/ptkp (1223) | BLOK | HR tidak punya layar koreksi PTKP; PTKP salah berarti PPh21 salah dan tak bisa dibetulkan tanpa API. |
| legend-foy | P1 | WS-09: Akses Fasilitas: Shower Room & WFC (F25) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-kta | P1 | WS-11: Dashboard & Laporan (F34, F35, F36) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-mf0 | P1 | WS-04: POS & Dapur (F11, F12) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-sop | P1 | WS-01: Platform, Identitas & Akses (F4, F6, F7) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-zn6 | P1 | WS-14: Operasional Harian (F41) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-07eg | P2 | WS-10 BE: Payroll run lifecycle: side-effect-free simulation, 2-level approval, lock, | BLOK | Siklus payroll run (simulasi, approval 2 level, kunci, batal) masih tercatat terbuka; alur gaji utama. |
| legend-0orff | P2 | WS-01 FE: panel Super Admin gateway pembayaran platform (nyala/mati, bawaan, jendela  | BLOK | Panel Super Admin gateway pembayaran (nyala/mati, bawaan, jendela webhook) belum ada; Duitku/DOIT tak bisa diatur aman tanpa SQL. |
| legend-113e | P2 | WS-08 BE: Campaigns + automations with consent gating, A/B split, redemption/revenue  | SESUDAH | Kampanye dan otomasi marketing; bukan inti loyalty tahap 1. |
| legend-17az7 | P2 | Pemantau error production (Sentry atau sejenis): belum ada env maupun kode | KEPUTUSAN FOUNDER | Pilih dan sediakan akun pemantau error production (Sentry atau sejenis). |
| legend-19gb | P2 | POS e-receipt: deliver e-receipts requested on an edge | SESUDAH | E-receipt dari edge; sekunder. |
| legend-1j8o9 | P2 | Loyalty: rekonsiliasi finance untuk poin/jurnal yang diparkir (PT asal ambigu) | SESUDAH | Poin/jurnal loyalty yang diparkir (PT asal ambigu); parkir fail-closed. |
| legend-1ye3 | P2 | WS-11 BE: Dashboard APIs (owner, shareholder, management home) with p95 <=3 s + share | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-1yig6 | P2 | Sandbox proof DOIT/Duitku: QRIS status after expiry, min expiryPeriod | BLOK | Belum terbukti di sandbox: QRIS kedaluwarsa masih bisa dibayar atau tidak; risiko uang masuk tanpa pesanan. |
| legend-29vw | P2 | WS-07 BE: Auto-journals: COGS, purchases/AP, production, waste, stock adjustments | BLOK | Jurnal otomatis HPP/pembelian/produksi/waste masih terbuka; stok dan HPP di buku bisa salah. |
| legend-2ggcc | P2 | SMS (OTP/notifikasi): tidak ada env maupun kode; putuskan perlu atau cukup WhatsApp/e | KEPUTUSAN FOUNDER | Putuskan apakah SMS dibutuhkan atau WhatsApp/email cukup. |
| legend-2t69x | P2 | Pemindai dokumen produksi: terima bukti payout PDF (sekarang 503) | SESUDAH | Pemindai bukti payout PDF 503 (fail-closed). |
| legend-316 | P2 | WS-06 BE: Goods receipt (partial, QC) + supplier invoice + 3-way match + supplier pay | BLOK | Penerimaan barang, faktur supplier, 3-way match, dan bayar supplier masih terbuka; stok dan utang bisa salah. |
| legend-31fi | P2 | WS-11: owner sign-off on the proposed 105-report standard catalog | KEPUTUSAN FOUNDER | Owner harus menandatangani katalog 105 laporan standar. |
| legend-39d.6 | P2 | WS-12 BE: AI-06 kitchen assistant + AI-08 forecast-driven usage (blocked: no recipe t | SESUDAH | Fitur Tanya AI/asisten dapur; di luar scope dan router AI untuk tablet belum dibuka. |
| legend-3a5m | P2 | WS-05: ledger impor settlement gateway + emit settlement.reconciled (prasyarat auto-j | SESUDAH | Rekonsiliasi settlement gateway/EDC ke bank; prasyarat pelaporan, bukan transaksi. |
| legend-3tyl1 | P2 | Refund echo skip: bandingkan dengan jumlah ditagih provider, bukan intent (SO 1200 P3 | BLOK | Refund yang jumlah ditagih penyedia lebih besar dari intent bisa dibayar dua kali (bead sendiri bilang sebelum rilis). |
| legend-45lm | P2 | Payroll: alur finance piutang PPh21 karyawan keluar dan penghapusan (write-off) | SESUDAH | Alur finance piutang PPh21 karyawan keluar; kasus langka, bisa manual. |
| legend-48egz | P2 | Layar finance: bukti payout tertahan backfill dan baris utang gaji yang ditahan (paya | SESUDAH | Layar finance bukti payout tertahan; tampilan, data sudah ditahan. |
| legend-4itg8 | P2 | POS refund: show and track the online (QRIS) part that is not paid out yet | SESUDAH | Tampilan bagian QRIS refund belum dibayar; visibilitas, bukan uang. |
| legend-4ixab | P2 | Race lama: resume dikonfirmasi DOIT lalu guard CANCEL_PENDING CONFLICT (billing jalan | SESUDAH | Race DOIT recurring pada langganan fasilitas, di luar rilis 1. |
| legend-4t4g7 | P2 | Gerbang rilis: cek baris reservasi legacy tanpa deposit_payment_link_id di production | BLOK | Gerbang rilis: baris reservasi legacy tanpa deposit_payment_link_id di production bisa menahan deposit tanpa batas. |
| legend-77vru | P2 | Hold refund sementara memotong refund item gagal (ORD-09) permanen | SESUDAH | Sisi restriktif (tamu kurang dikembalikan sementara), tidak merugikan outlet. |
| legend-7fcc | P2 | WS-08 CRM FE/CT: review queue names + campaign detail reads beyond the first 100 rows | SESUDAH | Kampanye dan otomasi marketing; bukan inti loyalty tahap 1. |
| legend-7fjy | P2 | WS-09 BE: Shower + breakfast: hold order, auto-fire before session end per prep time, | SESUDAH | Fasilitas (shower/WFC) di luar rilis 1. |
| legend-7xhcl | P2 | A1 memakai jenis karyawan sekarang: non-tetap diangkat PKWTT tengah tahun dilaporkan  | SESUDAH | A1 ganda untuk karyawan diangkat PKWTT tengah tahun; A1 baru dipakai akhir tahun, kasus tepi. |
| legend-7zwmv | P2 | Edge: gerbang Owner catalog override pakai jam tepercaya, bukan jam DB lokal (SO 1201 | SESUDAH | Gerbang override katalog Owner edge pakai jam tepercaya; kasus tepi P3. |
| legend-834cr | P2 | Akses layar pelanggan yang belum terpasang ke state berisi kode pairing | SESUDAH | Layar pelanggan: pairing/promo saat diam; kosmetik. |
| legend-905j | P2 | WS-07 BE: Auto-journals: payroll, loyalty point liability, dividends, depreciation | BLOK | Jurnal otomatis payroll, kewajiban poin loyalty, dividen, penyusutan masih terbuka; buku akuntansi tidak lengkap. |
| legend-94xqo | P2 | Satukan env storage: STORAGE_S3_* vs OBJECT_STORAGE_* (deploy rawan salah) | BLOK | Dua set env storage (STORAGE_S3_* dan OBJECT_STORAGE_*) membuat deploy rawan salah dan fitur dokumen gagal; bead sendiri minta sebelum rilis. |
| legend-9og5z | P2 | Ekspor pajak basi: UI badge, route reversal, dialog lock tampilkan taxExportsSupersed | SESUDAH | UI ekspor pajak basi; kosmetik/alur sekunder. |
| legend-9vrn | P2 | WS-09 BE: Session lifecycle: timer, 5-min reminder push, overtime charge, auto cleani | SESUDAH | Fasilitas (shower/WFC) di luar rilis 1. |
| legend-arj.5 | P2 | WS-10 BE: final settlement amounts from payroll engine (prorated salary, THR, BPJS, l | BLOK | Angka settlement karyawan keluar (prorata, THR, BPJS, cuti) masih terbuka; salah hitung = bayar lebih/kurang. |
| legend-atcu | P2 | WS-11 BE: Report engine + standard report definitions + report builder backend + sche | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-axmob | P2 | Kirimdev produksi: akun, nomor, langganan webhook, secret, uji langsung | KEPUTUSAN FOUNDER | Akun, nomor, dan secret Kirimdev production butuh founder; ikut rilis 1 atau tidak. |
| legend-ay6e6 | P2 | WS-11 ekspor dan jadwal laporan | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-b2kq3 | P2 | Layar AI: tindak lanjut audit (Cabut saat kunci platform, polling diam, 2 tombol utam | SESUDAH | Fitur Tanya AI/asisten dapur; di luar scope dan router AI untuk tablet belum dibuka. |
| legend-b3k | P2 | WS-02 BE: Edge standby failover: 15-min snapshots + event replay, promote standby <=1 | SESUDAH | Failover standby edge 15 menit; ketahanan lanjutan. |
| legend-bg5wy | P2 | 1199 P3: warn bila deaktivasi edge tertahan (promo bisa tetap diskon offline), gate p | SESUDAH | Temuan P3 kualitas edge/promo. |
| legend-ckl6d | P2 | 1102 kas: jurnal manual dan berulang yang mengkredit 1102 melewati saldo tersedia: pe | SESUDAH | Peringatan jurnal kas lewat saldo; pembukuan, bukan pembayaran. |
| legend-cs7 | P2 | WS-05 BE: Settlement reconciliation engine: DOIT settlements + EDC batch settlement p | SESUDAH | Rekonsiliasi settlement gateway/EDC ke bank; prasyarat pelaporan, bukan transaksi. |
| legend-dpc | P2 | WS-02 BE: Wi-Fi controller vendor adapter (chosen model) on WifiProvider | SESUDAH | Adapter vendor Wi-Fi controller; di luar scope. |
| legend-ecr16 | P2 | Rekonsiliasi refund edge lama yang belum pernah tersinkron ke pusat (sebelum batas Q6 | BLOK | Refund edge lama yang tak pernah sinkron membuat pusat tidak tahu dan batas kumulatif refund bisa terlewati (bayar lebih). |
| legend-egbs7 | P2 | Designer + UI: layar target penjualan outlet (WS-11 F1) | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-ei9ot | P2 | Kredit pelanggan reservasi tidak mengurangi tagihan POS yang sudah submit sampai repr | SESUDAH | Aman uang (outlet terima penuh); hanya tampilan QR tidak langsung berkurang, reservasi. |
| legend-f2rv | P2 | WS-07 BE: Tax recap + Coretax DJP exports (PBJT, PPh 21 from payroll, PPh 23, PPN mas | SESUDAH | Rekap pajak dan ekspor Coretax dibutuhkan saat lapor bulanan, bukan hari rilis. |
| legend-f7ybx | P2 | Allowlist tablet: aturan ai-kds tanpa actorOf; router /api/ai/* masih requireAuth (Ta | SESUDAH | Fitur Tanya AI/asisten dapur; di luar scope dan router AI untuk tablet belum dibuka. |
| legend-ff393 | P2 | 1012 keputusan produk: layar reservasi, Tanya AI KDS, _ops/fasilitas di perangkat ber | KEPUTUSAN FOUNDER | Keputusan produk: reservasi, Tanya AI KDS, fasilitas di perangkat bersama jadi POS atau disembunyikan. |
| legend-fnxl.8 | P2 | WS-07 lanjutan: auto-match settlement gateway/EDC ke mutasi bank | SESUDAH | Rekonsiliasi settlement gateway/EDC ke bank; prasyarat pelaporan, bukan transaksi. |
| legend-gdjpu | P2 | SO 1111 P2: ACK void edge bisa mendahului ingest sukses -> run struk ditolak tanpa pe | BLOK | ACK void edge bisa mendahului ingest sukses sehingga run struk ditolak tanpa pemulihan otomatis; sinkron kasir tersangkut. |
| legend-gq0w | P2 | WS-09 CT: re-display a ticket credential (QR/PIN) on the guest's device | SESUDAH | Fasilitas (shower/WFC) di luar rilis 1. |
| legend-h6k7c | P2 | Refund flag mati: refund dengan jejak penyedia yang macet tidak bisa dicatat manual ( | KEPUTUSAN FOUNDER | Butuh keputusan CTO/founder: boleh lewati lookup saat flag refund DOIT mati. |
| legend-hyq | P2 | WS-05 BE: Notification channels: web push (VAPID), email (SPF/DKIM provider), WhatsAp | SESUDAH | Kanal notifikasi email/push dan domain email pengirim; provider email belum ada. |
| legend-ijy8u | P2 | Uang: platform-approval cek peran dan tenggat chain pakai waktu pasca-lock (sekarang  | SESUDAH | Sisa risiko sudah gagal-aman. |
| legend-im8n | P2 | WS-08 BE: GoFood / GrabFood / ShopeeFood real adapters | SESUDAH | Adapter GoFood/Grab/Shopee di luar rilis 1. |
| legend-iojd1 | P2 | Celah tiket fasilitas POS 1039: refund setelah jam mulai, refund item Rp0/Rp1 mencabu | SESUDAH | Fasilitas (shower/WFC) di luar rilis 1. |
| legend-j2l2 | P2 | WS-10 BE: Payroll engine: components, BPJS (versioned rates/caps/shares), THR by tenu | BLOK | Mesin payroll (BPJS, THR, kasbon) masih tercatat terbuka; gaji salah jika belum lengkap. |
| legend-j7018 | P2 | Cek postCompletionJournal distribusi bagi hasil di periode tertutup (SO 1221 B4) | BLOK | Jurnal selesai bagi hasil memakai tanggal bayar terakhir, perlakuan periode tertutup belum diverifikasi (buku bisa tertulis di periode salah). |
| legend-j772n | P2 | POS: kontrak dokumen receipt/invoice perlu bucket DP | SESUDAH | Kontrak dokumen bucket DP berlaku pesanan DP/reservasi, bukan alur utama. |
| legend-jhepl | P2 | Layar 'Refund perlu tindak lanjut' (tab di daftar refund admin) untuk API follow-ups  | SESUDAH | Layar tindak lanjut refund butuh mockup dulu, API sudah ada. |
| legend-k0i8 | P2 | WS-04 BE: offline POS order sync from edge to cloud — late adjustment to next open bu | BLOK | Sinkron order POS offline dari edge ke cloud (penyesuaian terlambat ke hari buka berikutnya) masih terbuka; penjualan/pajak harian bisa salah hari. |
| legend-kpg76 | P2 | WhatsApp: bukti kepemilikan nomor sebelum aktif untuk login | KEPUTUSAN FOUNDER | Bukti kepemilikan nomor WhatsApp untuk login bergantung keputusan WA rilis 1. |
| legend-l344l | P2 | Layar pelanggan: tampilkan promo saat diam dan kode pairing (UI) | SESUDAH | Layar pelanggan: pairing/promo saat diam; kosmetik. |
| legend-l3bq | P2 | WS-10 BE: PPh 21 TER engine (PP 58/2023): monthly TER, final-period recalculation, PT | BLOK | Mesin PPh21 TER (inti pajak gaji) masih tercatat terbuka; pajak gaji salah jika belum lengkap. |
| legend-lv2l | P2 | WS-07 BE: Financial statements + multi-entity + P&L per outlet with drill-down to sou | SESUDAH | Laporan keuangan dan P&L per outlet; pelaporan. |
| legend-lybix | P2 | Finance: jalur penyelesaian operator untuk jurnal refund terparkir REFUND_SOURCE_PEND | SESUDAH | Penyelesaian operator jurnal refund terparkir; fail-closed, desain dulu. |
| legend-m0mch | P2 | WS-01 BE+UI: domain email pengirim per brand diatur Super Admin (SumoPod custom domai | SESUDAH | Kanal notifikasi email/push dan domain email pengirim; provider email belum ada. |
| legend-m2m03 | P2 | Urutan kunci impor pajak dan service-charge: kunci chart sebelum tenants FOR UPDATE ( | SESUDAH | Urutan kunci impor pajak/service-charge; risiko deadlock langka. |
| legend-mqds | P2 | WS-11 BE: Export service CSV/XLSX/PDF with server-side PII approval gate + audit | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-mtbq9 | P2 | WS-05 BE: refund Duitku (API refund atau runbook payout manual) | KEPUTUSAN FOUNDER | Refund Duitku: pilih API refund atau runbook payout manual (keputusan bisnis dan uang). |
| legend-o5iyl | P2 | 1125 Cakupan synthetic_full belum mengikuti aturan universal 1119 | SESUDAH | Kesesuaian kontrak; CTO sudah menerima untuk sesudah rilis 1, total keluar tetap <= dibayar. |
| legend-oahzs | P2 | Minta contoh payload refund.failed dari DOIT sebelum DOIT_REFUNDS_ENABLED dinyalakan | SESUDAH | Contoh payload refund.failed DOIT hanya dibutuhkan sebelum flag refund DOIT dinyalakan. |
| legend-ofu02 | P2 | Cek baris missing lama (source_transaction_id NULL) di staging sebelum rilis; isi kol | BLOK | Gerbang rilis: baris rekonsiliasi lama tanpa source_transaction_id harus dicek/diisi sebelum rilis. |
| legend-oh2a5 | P2 | Gerbang rilis: hitung di staging jumlah tenant yang akan dinyalakan migrasi 0451 ai_a | SESUDAH | Gerbang info jumlah tenant AI auto-enable; AI di luar scope, hanya mencetak hitungan. |
| legend-p6key | P2 | DOIT recurring: rancang ulang wire ke /v1/billing/{plans,subscriptions} | SESUDAH | DOIT recurring dipakai langganan fasilitas, di luar rilis 1. |
| legend-pk38k | P2 | Retur Rp0 pesanan DP: pendapatan item tetap tercatat sampai koreksi deposit admin | SESUDAH | Retur Rp0 pesanan DP: jalur reservasi/DP, keputusan CTO sudah ada, tidak memblokir. |
| legend-pxm8 | P2 | WS-08 BE: campaign automation triggers + contract endpoints (automations welcome/birt | SESUDAH | Kampanye dan otomasi marketing; bukan inti loyalty tahap 1. |
| legend-pxpu4 | P2 | Pembalikan jurnal manual lewat rantai approval jurnal manual | SESUDAH | Pembalikan jurnal manual lewat approval; kasus langka. |
| legend-qgdp6 | P2 | Kurir/pengiriman: tidak ada kode (KirimDev hanya WhatsApp); founder konfirmasi perlu  | KEPUTUSAN FOUNDER | Founder konfirmasi apakah kurir/pengiriman perlu dan pilih penyedianya. |
| legend-qlirp | P2 | WS-11 laporan Keuangan | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-rx5ik | P2 | Pajak: alur penyesuaian selisih lintas periode (faktur vs posting vs akhir run) supay | SESUDAH | Penyesuaian selisih pajak lintas periode; alur koreksi, bukan transaksi harian. |
| legend-sdet | P2 | WS-14 BE: Temperature logs with corrective-action gate, prep labels linked to batches | SESUDAH | Log suhu/label prep (operasional harian) di luar daftar scope. |
| legend-sqp1 | P2 | WS-09 BE: Facility subscriptions via DOIT recurring: first invoice, periodic invoice  | SESUDAH | Langganan fasilitas via DOIT recurring di luar rilis 1. |
| legend-t1ufu | P2 | SO 1173 architect P2: re-raise of known evidence_read_locked flag must not be best-ef | BLOK | Satu flag gagal dalam chunk payout gaji membatalkan hold baru, sehingga slip bisa terbayar padahal bukti terkunci. |
| legend-t93l8 | P2 | POS: pemilih QRIS/EDC untuk tagih charge tukar menu di layar kasir (mockup dulu, gerb | KEPUTUSAN FOUNDER | Mockup pemilih QRIS/EDC tukar menu butuh review founder dulu. |
| legend-tltue | P2 | Penanda 'ganti penerima menunggu persetujuan' di kontrak dan UI profit share | SESUDAH | Penanda ganti penerima menunggu persetujuan; kosmetik kontrak/UI. |
| legend-tomda | P2 | Receipt biaya 0 ke stok negatif menurunkan HPP; bergantung urutan baris (SO 1221 B3) | BLOK | Receipt biaya 0 ke stok negatif menurunkan HPP sehingga laba dan bagi hasil terlihat naik. |
| legend-tvkuz | P2 | WS-10 C8: UI layar absen outlet di edge (QR + PIN + selfie kamera) | BLOK | UI absen outlet di edge (QR+PIN+selfie) belum ada; tanpa absen, payroll tidak punya data hadir. |
| legend-tz9hb | P2 | Service charge distribute: tambah total run + restore saat reversal sebelum diwire | SESUDAH | Route distribute service charge belum ada (dorman), wajib hanya sebelum route dibuat. |
| legend-uhs3c | P2 | EDC tender saat edge offline: cek PRD Alur W 1300-1306, pasang port EDC di edge node  | SESUDAH | EDC offline di luar rilis 1. |
| legend-v9bfj | P2 | Batas payout payment.refunded yang menunggu receipt dead-letter (guards.ts), sesudah  | SESUDAH | Jurnal payout refund menunggu receipt tanpa batas; parkir, tidak ada uang keluar salah. |
| legend-vgw8v | P2 | Rapel finalize membayar gross tanpa PPh21; jangan sambung ke production (SO 1221 A P3 | SESUDAH | Rapel finalize gross tanpa PPh21 sudah dijaga: jangan disambung ke production. |
| legend-vpx | P2 | WS-02 BE: EDC bank adapters (>=2 banks ECR specs) on EdcProvider | SESUDAH | Adapter EDC bank di luar rilis 1. |
| legend-vsw4q | P2 | UI write-off nomor struk hilang (owner) | SESUDAH | UI write-off nomor struk hilang; kasus langka. |
| legend-w4wjv | P2 | Tombol tes koneksi di layar admin untuk EDC dan marketplace (testGatewayConnection ha | SESUDAH | Tombol tes koneksi EDC/marketplace; keduanya di luar rilis 1. |
| legend-w8cwg | P2 | Drift schema: db:generate di basis ws/1096 (a93468ca8, turunan ghostex/45769078) meng | BLOK | Drift skema: db:generate menghasilkan migrasi tabel access_ticket_credential yang tak ada di drizzle/; migrasi deploy bisa gagal. |
| legend-wbyss | P2 | Edge: forward klaim poin ke cloud saat online | SESUDAH | Forward klaim poin edge ke cloud saat online; tidak merugikan uang. |
| legend-whd5c | P2 | Kredit tamu: penyelesaian dana ditolak 503 karena adapter ledger belum ada | SESUDAH | Kredit tamu ditolak 503 (fail-closed); fitur bisa ditunda. |
| legend-wnkep | P2 | WS-10: Payroll disbursement (Duitku auto + manual bank transfer) | SESUDAH | Epik penampung, bukan pekerjaan; cek anak epik (bd children) untuk menentukan BLOK. |
| legend-wxvt9 | P2 | Gerbang rilis: dry-run backfill piutang PPh21 di staging | BLOK | Backfill piutang PPh21 harus di-dry-run di staging sebelum produksi, kalau tidak PPh21/piutang karyawan bisa salah. |
| legend-x73li | P2 | WS-11 sambung FE laporan dan dasbor ke API asli | BLOK | Layar laporan/dasbor belum disambung ke API asli; angka palsu bisa tampil ke owner. |
| legend-xhl5j | P2 | Promo refund: voucher kembali saat diskon manual ditumpuk (1219 P3) | BLOK | Voucher promo kembali padahal diskon manual ditumpuk; tamu untung kecil dan outlet rugi (aturan jangan sampai rugi). |
| legend-xvhd9 | P2 | Web: layar koreksi payout failed ke succeeded (dua orang, bukti sama, password) | SESUDAH | Layar koreksi payout failed ke succeeded; koreksi langka, bisa lewat API. |
| legend-y3huu | P2 | WS-11 laporan SDM: absensi, payroll, kinerja | SESUDAH | Laporan, ekspor, dasbor, target penjualan; pelaporan sekunder. |
| legend-y9o7 | P2 | WS-08 BE: Waitlist with ETA + browser notification call, reservation reminders (email | SESUDAH | Waitlist/pengingat reservasi bukan inti tahap 1. |
| legend-zlc6 | P2 | POS-04 immutability blocks tenant/outlet purge (edge_nodes no-delete, final orders fr | SESUDAH | Kebijakan retensi purge tenant; belum relevan di rilis awal. |

## Verifikasi kode 1238 (int/batch104, grep tingkat modul, indikatif)

- Kode ada (tutup sesudah cek kriteria + test): l3bq, w8cwg, 94xqo, t1ufu.
- SEBAGIAN: j2l2 (settlement masih tunggu engine), 07eg (total file bank = net belum terverifikasi), 29vw (consumer goods.received/supplier_invoice.matched/supplier.paid tidak ketemu), 905j (jurnal poin/dividen/penyusutan belum dicek), 316 (QC, GR parsial), tvkuz (layar absen edge), 3tyl1 (isi fix belum dibaca).
- BELUM atau tanpa penanda: arj.5 (angka settlement karyawan keluar masih PENDING_PAYROLL_ENGINE), x73li (laporan/dasbor web masih `mock.ts`), 0orff (panel gateway Super Admin), k0i8, xhl5j, gdjpu, ecr16, tomda.
- Perlu kartu: x73li dan arj.5 paling besar dampaknya untuk rilis. Sisanya cek kriteria per bead dulu (architect/Explore per area), lalu kartu.

## Status 21 Nov (1240 + 1247)

- Ditutup (bukti kode + test di m1 6f418df53): t1ufu, 3tyl1, 94xqo, w8cwg, du7t5, l3bq, j2l2 (+8di9d, sko14, pf9u7), 316.
- Dikerjakan gelombang 1 (`docs/briefs/1241-1247-rilis1-gelombang1.md`): arj.5 (1241), tomda (1242), xhl5j (1243), ecr16 (1244), gdjpu (1245). Sizing architect 1246: k0i8, x73li (+qlirp, ay6e6, y3huu), tvkuz, 0orff.
- Sisa kecil untuk gelombang 2: 07eg (generator payslip PDF tidak ada, `hris-payslip.service.ts:164` hanya baca; bead s5c1 lease kedaluwarsa), 905j (dividen memakai `distribution.completed`, bukan `distribution.paid`: cek kriteria), 29vw (konsumsi/output produksi tanpa mapping jurnal sendiri), j7018 (test bayar terakhir bertanggal mundur ke periode tutup).
- Butuh kunci sandbox dari founder: 1yig6, astv2, 7tqe8 (DOIT/Duitku sandbox). Ops saat staging: wxvt9.
