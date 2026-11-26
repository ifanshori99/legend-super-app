# Rilis cloud-only: rancangan architect (27 Nov, dasar int/rc2 fa822938f)

**Keputusan:** semua tablet kasir, dapur (KDS) dan captain bicara langsung ke server cloud. Struk dicetak dari tablet. POS boleh jalan offline terbatas, hanya untuk tunai dan EDC manual. Kode mini PC dibekukan, tidak dihapus.

## 1. Yang dibekukan dan yang tetap
- **Dibekukan, mati bawaan:**
  - Proses `EDGE_MODE` (server outlet), `EDGE_FAILOVER_ENABLED=false`, `EDC_AGENT_ENABLED=false`, Print Agent edge, standby.
  - Proksi E9, kartu A3-A6, B-E1/3/4/6, E5, E10, E11, F2-F4, F11*, F12, .36/.37, sxj96.*.
  - WIP E6, F4 dan E9: cabangnya disimpan, tidak digabung dan tidak direview lagi.
- **Aman bila edge tidak pernah di-enroll.** `outletHasActiveEdge` (`apps/api/src/services/pos-edge-outlet.ts:52`) hanya menghitung `edge_nodes.status='active'`. Tanpa baris itu, cloud melayani outlet seperti biasa, dan F3 window tidak pernah terbuka.
- **Celah:** satu enroll yang tidak sengaja langsung memblokir penjualan cloud di outlet itu. Karena itu perlu kartu K0: saklar `EDGE_NODES_ENABLED=false` yang menolak create/activate di `apps/api/src/routes/edge-nodes.routes.ts`, ditambah `apps/api/src/config/env.ts` dan `deploy/single-vm/runtime.env.example`.
- **Tetap jalan:** POS cloud (W1-W6), EDC manual, Duitku, laporan, WFC, HRIS dan payroll, KDS realtime cloud.

## 2. POS offline di tablet (no. 23), pola Moka/Majoo
- **Yang jalan offline:** order baru, tunai, EDC manual (nomor referensi slip wajib), promo otomatis dari snapshot, pajak dan service dari snapshot.
- **Yang ditolak offline:** QRIS/VA/e-wallet, poin, voucher atau kode promo, DP, WFC pass, refund, void sesudah bayar, buka shift, ganti kasir, tutup shift, dan bill terbuka dari cloud.
- **Bekal offline:** dibagikan cloud saat buka shift, masa berlaku 24 jam. Isinya katalog dan harga ber-versi, plus satu prefix seri per perangkat dan per epoch (pola `ensureFailoverSequence` di `pos-receipt.service.ts:425`, seri baru `offline`). Nomor struk = prefix + urutan lokal tanpa celah. Penyimpanan hilang berarti epoch baru, tidak pernah dipakai ulang.
- **Antrean:** IndexedDB, hanya tambah (append-only), memakai `navigator.storage.persist()`. Logout ditolak selama antrean belum kosong. Banner menampilkan "N transaksi belum terkirim".
- **Sinkron:** `POST /api/pos/offline-batch` idempoten per eventId ULID. Urutan per epoch harus bersambung. Isinya dialihkan ke `apps/api/src/edge/order-ingest.ts`: nominal diambil dari payload (R2), tidak pernah throw sesudah diparkir (R1). Pakai ulang dengan sumber yang diabstraksi (edge node atau tablet).
- **Penjagaan saat sinkron:** harga yang beda dari snapshot masuk "perlu dicek", tidak ditolak, karena uangnya sudah diterima. Shift yang sudah ditutup paksa diproses lewat `edge/late-adjustment.ts`.
- **Dapur saat offline:** tablet kasir mencetak slip "DAPUR" di printernya sendiri.
- **Kartu dan estimasi:**
  - O1 kit dan prefix, migrasi (Opus K, 10 jam)
  - O2 ingest batch (Opus xhigh, 14 jam)
  - O3 penyimpanan lokal, sinkron, service worker app-shell untuk `/pos` (Opus, 14 jam)
  - O4 UI offline (ui, 10 jam + mockup)
  - O5 test dan drill (Sonnet, 8 jam)
  - Total sekitar 56 jam ditambah review.

## 3. Struk, KDS, EDC tanpa mini PC (no. 22)
- **Cetak:**
  - Rekomendasi: tablet Android + Chrome PWA + aplikasi RawBT (intent `rawbt:base64,<ESC/POS>`). Bisa ke printer Bluetooth, USB atau LAN.
  - ESC/POS dibuat di cloud dengan memakai ulang `apps/api/src/edge/print/{templates,escpos}.ts`. Cetak ulang ditandai lewat `markReprint`.
  - Status cetak cukup "dikirim ke printer", tidak pernah "tercetak".
  - Cadangan: `window.print` HTML 58/80 mm.
  - Epson ePOS dan Star WebPRNT ditolak: butuh model printer tertentu dan sertifikat HTTPS di LAN, mudah rusak.
- **KDS:** layar realtime cloud (sudah ada). Printer dapur opsional, dicetak dari tablet KDS stasiun itu.
- **EDC:** EDC manual sebagai jalur normal. Kasir wajib isi nomor ref slip, tanpa PIN supervisor. `needs_reconciliation` ditandai, lalu direkonsiliasi H+1 lewat `edc-reconciliation.service.ts`. Ref yang belum cocok lebih dari 1 hari memunculkan peringatan untuk shift itu.
- **ECR otomatis:** butuh spesifikasi bank (legend-mooi). Jalurnya adapter cloud-ECR bank, atau aplikasi Android tipis. Ditunda sesudah rilis.
- **Kartu dan estimasi:**
  - P1 API byte cetak (Sonnet, 8 jam): `pos-receipt-edge-print.ts`, `pos-receipt-delivery.service.ts`, `pos-shift-print.ts`, `kds-print.service.ts`
  - P2 adapter cetak web plus setelan printer per tablet (ui, 10 jam): `apps/web/src/features/ws04-pos-kasir/print/**`
  - P3 cetak dari KDS (Sonnet, 5 jam)
  - X1 EDC manual normal (Opus K, 6 jam): `pos-edc-standalone.ts`, `pos-edc-tender.ts`
  - X2 impor settlement EDC per bank lewat CSV (Opus K, 10 jam)

## 4. Kartu tersisa menuju siap deploy (urut prioritas)
1. K0 saklar enroll (2 jam). Hentikan E6, F4, E9.
2. Jalur paralel, berkas tidak bertumpuk:
   - **Lajur Cetak:** P1, lalu P2, lalu P3.
   - **Lajur Offline:** O1, lalu O2, lalu O3/O4 (O4 sesudah P2 karena sama-sama di `ws04-pos-kasir`).
   - **Lajur Duitku:** .40/.41 C2a (7 jam), lalu C3a (12 jam), lalu C3b (10 jam). C4b (6 jam) sesudah .47. C2b (10 jam, mockup dulu).
   - **Lajur Laporan:** D2 qlirp, lalu D4 ay6e6 (14-20 jam), lalu D5 x73li (5-8 jam). Satu agent saja.
   - **Lajur Kecil:** X1/X2, f1mmf, 9yw78.12, V1 (audit poin, voucher dan DP di kasir cloud, 4 jam ditambah perbaikan celahnya).
3. Deploy VPS lewat `deploy/single-vm/deploy.sh` ke staging, lalu backup dan restore drill (legend-cqr), lalu PPh21 staging (wxvt9).
4. Sesudah domain hidup: C1 bukti sandbox Duitku dan 7tqe8 (4 jam), C5 e2e Duitku (5 jam), 9yw78.19.
5. KirimDev: `KIRIM_*` plus `NOTIFICATION_WHATSAPP_PROVIDER`, uji OTP dan notifikasi di staging (4 jam). Email SMTP/Brevo dan Sentry (2 jam).
6. Gerbang akhir: suite penuh `node scripts/test-shards.mjs --chunks 8 --lanes 2 --heavy`, `heavy pnpm test:e2e`, second-opinion per area (Duitku, offline, cetak), lalu gerbang founder untuk merge ke main.

Perkiraan total sekitar 230 jam agent dengan 4 lajur.

## 5. Yang founder siapkan
- **Akun dan kunci:** Duitku (merchant code dan API key, sandbox dan production); KirimDev (API key, webhook secret, nomor WhatsApp); VPS minimal 4 vCPU/8 GB plus akses SSH (lewat `ghostex secret request`); domain dan akun Cloudflare; email pengirim plus SPF/DKIM; Sentry DSN; storage off-site untuk backup dan berkas; DOIT opsional.
- **Perangkat:** tablet Android, printer thermal ESC/POS (Bluetooth atau LAN), lisensi RawBT per tablet, modem 4G cadangan untuk router.

## 6. Yang butuh keputusan founder (uang dan bisnis saja)
1. ECR otomatis mundur sesudah rilis 1. Rilis 1 memakai EDC manual dengan ref wajib dan rekonsiliasi H+1.
2. Saat offline hanya tunai dan EDC manual. Poin, voucher, DP dan QRIS hanya saat online (sama dengan Moka/Majoo).
3. Pembelian perangkat: tablet, printer, RawBT, modem 4G.

Sisanya diputuskan CTO: tanpa plafon untuk tunai offline, bekal offline berlaku 24 jam, selisih harga masuk "perlu dicek".

**Risiko:**
- RawBT tidak memberi konfirmasi cetak.
- Tablet yang hilang sebelum sinkron membuat penjualannya tidak tercatat, dan muncul sebagai selisih laci.
- Salah satu dari tiga keputusan di atas ditolak menambah sekitar 40 jam ke rencana.

## Keputusan CTO 27 Nov (founder no. 30 dan 31)
- Rancangan diterima. Offline hanya tunai + EDC manual (standar Moka/Majoo); poin/voucher/DP/QRIS hanya online. Tunai offline tanpa plafon, bekal 24 jam, selisih harga masuk "perlu dicek". Status cetak "dikirim ke printer".
- E6, F4, E9 dihentikan; cabang disimpan (ws/1269-e6, ws/1271-f4, ws/1269-e9), tidak digabung.
- Ditanyakan ke founder: ECR otomatis mundur sesudah rilis 1 (EDC manual + rekonsiliasi H+1), dan pembelian perangkat.
- Slot edit maks 3: lajur Cetak (K0 lalu P1-P3), Offline (O1-O5), Duitku (C2a .40/.41, C3a, C3b, C4b, C2b). Laporan (D2/D4/D5) dan Kecil (X1/X2, f1mmf, 9yw78.12, V1) mengisi slot yang kosong.
- Migrasi sementara mulai 0533 (E6/E9 tidak digabung), dinomori ulang saat merge.

## Keputusan CTO O2 (27 Nov, dasar "jangan sampai rugi")
- (a) Tunai offline masuk total laci shift cloud yang sama (uang fisik ada di laci). Tutup shift ditolak selama antrean tablet belum kosong; hitung laci membandingkan dengan expected termasuk tunai offline.
- (b) Tiap penjualan offline mendapat baris struk nomor `L` (deret tanpa celah per epoch; celah = alert, bukan write-off diam-diam).
- (c) Stok dipotong cloud saat ingest (tablet tidak memegang stok).
- (d) Sumber/ledger baru `offline_tablet`, terpisah dari edge: penjualan offline yang ter-ingest menjadi order cloud biasa, refund lewat jalur refund cloud biasa (bukan penjaga sale edge).
- Promo otomatis tidak berlaku saat offline di v1 (harga daftar saja); UI menampilkan "Promo tidak berlaku saat offline". Route bekal di bawah outlet diterima.
- Nominal dari payload, tidak dihitung ulang; selisih harga vs snapshot masuk "perlu dicek". Satu eventId = satu order, replay aman.

## Keputusan CTO O4 (27 Nov)
- Menu offline dari bekal (dine-in/takeaway). Mockup design/mockups/pos/offline disetujui.
- Offline = browser offline ATAU ping API gagal 2x (~10 detik, gagal jaringan); online lagi sesudah ping sukses. Keranjang yang permintaan cloud-nya belum pasti tidak boleh dijual ulang offline (pengaman dobel); jual offline hanya keranjang baru.
- Antrean = sheet di layar kasir. Tutup shift menampilkan tunai belum terkirim dari tablet; tutup paksa supervisor masuk O4 supaya kafe tidak terkunci.
- Cetak struk offline lewat jalur cetak tablet bila tanpa server; selain itu nomor L + cetak ulang sesudah online (O5).

## Keputusan founder no. 32 (27 Nov): EDC otomatis wajib di rilis 1
- Founder: "edc wajib otomatis". Menggantikan §6 no. 1 (ECR mundur). EDC manual tetap ada sebagai jalan keluar saat EDC/jaringan gagal dan saat offline (kafe tidak boleh terkunci), tetapi jalur normal kasir = nominal dikirim otomatis ke mesin EDC dan hasil (approved/declined, RRN, approval code) kembali otomatis.
- Tantangan cloud-only: tanpa mini PC, tidak ada proses lokal yang bicara ke EDC. Pilihan dikaji architect (lihat `docs/design/edc-auto-cloud.md`): ECR cloud dari bank/acquirer, aplikasi jembatan Android di tablet (LAN/USB ke EDC), atau EDC Android dengan integrasi app-to-app. Mesin agent EDC yang sudah ada (E1-E7: write-ahead, idempotensi, `unknown` -> rekonsiliasi, PAN disamarkan) dipakai ulang.
- Butuh dari founder: bank dan merek/model EDC per outlet (contoh BCA Verifone, Mandiri Ingenico, BRI Android), dan apakah bank sudah memberi dokumen ECR.
