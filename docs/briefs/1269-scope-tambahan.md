# 1269 Tambahan scope rilis 1 (founder 25 Nov malam)

Dasar kode: worktree `../legend-rc1` (int/rc1 = milestone/m1). Baca saja dulu; laporan = rencana kartu.

Keputusan founder:
- Struk WAJIB tercetak lewat printer edge di outlet.
- Penyedia awal Duitku. Refund DOIT dibiarkan mati.
- WAJIB di rilis 1: EDC otomatis (ECR), VA/e-wallet/kartu online, laporan keuangan/absen/gaji/kinerja.

Aturan: uang paling membatasi, hasil tak diketahui mengunci, tidak ada data palsu, tanpa dukungan = tetap terkunci. Untuk tiap bagian tulis: apa yang sudah ada (file:line), apa yang kurang, apa yang butuh pihak luar/kredensial/alat fisik (dan apakah kode bisa dibangun dan diuji tanpa itu), kartu per berkas tak bertumpuk dengan `docs/briefs/1268-pos-wire.md`, perkiraan jam agent, risiko.

- A. Cetak struk dan tiket dapur lewat edge: topologi POS cloud -> edge -> printer, atau POS dilayani edge. Baca pos-receipt-edge-print.ts, apps/api/src/edge, ws02-edge, docs/design/edge-cloud-failover.md, bead 2lp dan anaknya.
- B. EDC otomatis (ECR): getEdgeEdcAgent, adapter bank (legend-vpx, legend-mooi), db/schema/edc.ts, ws02, ws04. Kerangka terminal simulator boleh, tidak boleh nyala di production.
- C. VA/e-wallet/kartu online lewat Duitku: untuk tamu (QR order, reservasi, tautan bayar) dan untuk kasir; gerbang 969/7tqe8; refund Duitku (layar manual 1259); rekonsiliasi dan jurnal.
- D. Laporan finance, attendance, payroll, performance: metricSourceOf / packages/shared/src/dashboard/source-availability.ts / ws11-reports; mana yang sumbernya sudah ada dan mana belum; izin akses data gaji; ekspor (legend-ay6e6).

## D. Kartu laporan (architect 25 Nov, dicek CTO)

Layar `ws11-reports/api.ts` sudah memanggil API asli; `metric-sources/hr.ts` dan `finance.ts` masih `sources: []`. Data hilang tampil kosong, bukan nol. Sumber wajib cocok dengan jurnal. Berkas `source-availability.ts` + registry: satu agent saja (D1 dan D2 berurutan).

- D1 (legend-y3huu): `metric-sources/hr.ts` attendance_late_count, overtime_hours, pecahan karyawan/stasiun (hanya karyawan dalam lingkup pemanggil). Sumber mentah `hris-attendance.ts:315`, `overtime_minutes`, `payroll-overtime-corrections`. failed_item_count bila datanya ada. 5-7 jam.
- D2 (legend-qlirp): `metric-sources/finance.ts` cash_balance dan bank_balance (saldo akun GL per tanggal), ebitda = laba bersih + bunga + pajak penghasilan + penyusutan dari jurnal (hanya periode tertutup); tanpa penanda akun bunga/pajak/penyusutan = tetap tak tersedia. pending_settlement, gateway_settlement, edc_settlement dari data settlement bila ada (B, C). 5-8 jam.
- D4 (legend-ay6e6): ekspor + persetujuan + jejak audit (K, gaji). 14-20 jam.
- D5 (legend-x73li): e2e layar laporan vs API asli + uji akses gaji (pemegang saham dan peran biasa ditolak). 5-8 jam.
- checklist_compliance_pct: modul checklist belum ada, tetap "Segera hadir".

## C. Kartu Duitku (architect 25 Nov)

Keputusan CTO: tiap metode terkunci lewat env sampai bukti sandbox (C1) ada. Kartu kredit tetap terkunci sampai prosedur dan jurnal chargeback ada; VA di kasir hanya setelah C1 lulus (paling membatasi, dilaporkan ke founder). Refund manual (1259). Nomor baris dari laporan architect, cek ulang sebelum dipakai. Path: `apps/api/src/{services,config,test,routes}`, `apps/web/src/features`.

Celah: (1) sandbox Duitku di production tidak ditolak (`payment-duitku.ts:97`); (2) 969/7tqe8 hanya aturan routing, VA nyala bawaan tenant baru (`platform-org.service.ts:345`); (3) tender QRIS kasir selalu tercatat `doit` (`pos-order-payment.ts:537`, event `pos-order.service.ts:1508`); (4) kasir menolak VA/e-wallet/kartu (:636), display hanya QRIS; (5) checkout tamu qris/va/kasir (`payment-methods.tsx:15`), tautan/DP qris/va/bank_transfer (`payment.service.ts:388`, `payment-gateway-select.ts:38`); (6) halaman kembali tidak ada; (7) `settlement.reconciled` tanpa emitter (legend-3a5m); (8) chargeback tidak ada; (9) bawaan routing masih `doit` (`payment-routing.service.ts:98`).

- C0 pengaman (Opus, 5 jam, sebelum B2): `payment-duitku.ts`, `config/env.ts`, `.env.example`, `pos-order-payment.ts`, test baru. `DUITKU_ENABLED_METHODS` bawaan kosong, berlaku di methods/channels/createIntent (`getStatus` tidak terkunci). Sandbox ditolak di production kecuali `DUITKU_ALLOW_SANDBOX` (staging). Provider tender dari intent, bukan literal `doit`.
- C1 sandbox (Sonnet, 4 jam + kredensial): `payment-duitku-sandbox.test.ts`, `docs/qa/duitku-sandbox-gerbang.md`; VA expiry diminta vs nyata, status sesudah lewat. Menutup 7tqe8, 1yig6.
- C2a tautan dan DP server (Opus, 7 jam, sesudah C0): `packages/shared/src/payment/index.ts`, `services/{payment.service,payment-gateway-select,payment-routing.service}.ts`. Return URL tunggal tanpa token.
- C2b web tamu (10 jam, mockup dulu): `ws05-payment/**`, `ws03-qr-order/components/cart/*`, `routes/_customer/bayar.kembali.tsx`. `resultCode` tidak dipercaya.
- C3a kasir server (Opus, 12 jam, sesudah B2 dan C0): `pos-order-payment`, `pos-qris-hold`, `customer-display.service`, `pos-payment-options.service`, `packages/shared/src/pos/*`, `pos-order.routes.ts`. Satu kode aktif; kunci semua metode sampai `02`.
- C3b kasir web (10 jam, sesudah W2 dan C3a; mockup display).
- C4a settlement server (Opus, 12 jam, paralel sesudah C0): `payment-settlement-import.service.ts`, `payment-settlement-emit.service.ts`, `packages/shared/src/payment/admin.ts`, `payment-admin.routes.ts`. Emit sekali per outlet, hanya bila cocok mutasi bank.
- C4b layar impor (6 jam, mockup): `ws05-payment-admin/**` kecuali dialog refund.
- C5 dokumen dan e2e (Sonnet, 5 jam): PRD D11/D14, runbook refund, credentials.
Test wajib: callback ganda/telat/nominal beda; ganti metode lalu kode lama dibayar (dana parkir); tunai saat kode hidup; hasil tak diketahui mengunci; sandbox di production ditolak.

## A+B. Kartu edge printer dan ECR (architect 25 Nov)

DITIMPA FOUNDER 25 Nov malam (POS wajib offline, lihat bagian E): rencana satelit di bawah dinilai ulang di bagian E. Usulan awal: POS dan buku uang tetap di cloud; edge = satelit periferal (cetak, lalu ECR) lewat link yang ada. POS dilayani edge ditolak untuk rilis 1 (hanya katalog yang tersinkron; refund/void tunai/poin/tiket/QRIS ditolak di edge; shift edge diparkir legend-8yqik). Node lama tetap mode `full`. Migrasi mulai 0524, nomor dibagi CTO. Path api = `apps/api/src/`.

Celah cetak: cloud menulis `sent` lalu tidak mencetak (`pos-receipt-delivery.service.ts:394-420`, `pos-receipt-edge-print.ts:60`); node aktif memblokir cloud (`pos-receipt.service.ts:495-542`, `edge-device-sync.ts:285`, `pos-day.service.ts:802`, `qr-order.service.ts:1893`, `panic-edge-ownership.ts:30`); tidak ada perintah cloud->edge dan hasil balik; `pos-shift-print.ts:40` dan `facility-pos-ticket-print.ts:77` diam di cloud; printer struk = baris pertama per outlet.

- A1 mode `peripheral` (Opus K, 8 jam, sesudah 1162): `db/schema/edge-node.ts` + migrasi, `edge-node.service.ts`, `edge-bootstrap.service.ts`, `edge/{bootstrap,mode,runtime}.ts`, `edge/qr-order-forwarding.ts`, `edge-device-sync.ts`, `pos-receipt.service.ts`, `pos-day.service.ts`, `panic-edge-ownership.ts`, `panic-alert-outbox.ts`. Mode dari cloud, default `full`, immutable; API POS di node menolak.
- A2 perintah cetak (Opus, 10 jam, sesudah A1): `packages/shared/src/edge/print-command.ts`, `edge_print_requests`, `edge-print-request.service.ts`, `edge/print/{request,result}-applier.ts`, `print/{store,agent}.ts`, `edge/runtime.ts`. Status `queued/printed/failed/unknown/expired`; kedaluwarsa 10 menit (dapur 5).
- A3 sambung struk/shift/tiket fasilitas (Sonnet, 7 jam, sesudah A2 dan B2): `pos-receipt-edge-print.ts`, `pos-receipt-delivery.service.ts`, `pos-shift-print.ts`, `facility-pos-ticket-print.ts`, `pos/{schemas,endpoints}.ts`; printer per kasir.
- A4 dapur (Sonnet, 8 jam, sesudah A2): `kds-print.service.ts`, `kds.service.ts`, `edge/print/kds-fallback.ts`, migrasi heartbeat.
- A5 UI status cetak (ui, 5 jam, sesudah A3 dan W2). A6 host + status kertas (Sonnet, 8 jam, sesudah A2): `deploy/edge/**`, `print/transport.ts` (2lp.11), legend-16s.
Test A: balasan hilang = satu cetak; `unknown` tidak dicetak ulang otomatis, cetak ulang bertanda; `full` tetap dijaga; cloud tak pernah mengaku tercetak; printer mati tidak membatalkan penjualan; lintas outlet/tenant ditolak.

Celah ECR: `getEdgeEdcAgent` tak dipanggil route; agent cek tagihan di DB lokal (`agent.ts:1621`); terminal tak disinkronkan; event `edc_transaction.*` tanpa applier; `payment_edc_terminals` tanpa port; registry production kosong (vpx, mooi).
Desain: cloud insert `pending` di bawah kunci tagihan + guard -> perintah (id dan trace sama, kedaluwarsa 20 detik) -> agent -> event hasil -> applier. Tanpa hasil = `unknown` = semua cara bayar terkunci; buka hanya lewat hasil edge atau rekonsiliasi Owner/Finance + MFA.
- B-E1 terminal turun (Opus K, 6 jam, sesudah A1): `catalog-sync.ts`, `edge-catalog-{sync,apply}.ts`, `catalog-puller.ts`, migrasi.
- B-E2 agent satelit (Opus xhigh, 10 jam, sesudah B-E1 dan A2): `edc/{agent,runtime}.ts`, `edc/command-applier.ts`, `shared/src/edc/command.ts`.
- B-E3 cloud mulai/cek/batal (Opus xhigh, 12 jam, sesudah B-E2 dan B2): `pos-edc.routes.ts`, `pos-edc-request.service.ts`, `edc-event-applier.ts`, `routes/index.ts`, `pos-order-support.ts`.
- B-E4 UI kasir (Opus, 8 jam, sesudah B-E3 dan W2). B-E6 e2e simulator (Sonnet, 5 jam).
- B-E5 adapter per bank (Opus, 12-20 jam per bank + sertifikasi): butuh spesifikasi + terminal. Jangan menebak protokol.
Test B: balasan hilang di tiap hop = maksimum satu sale; perintah terlambat tidak menagih; tender lain menyalip ditolak; restart = `unknown`; nominal beda = tidak lunas; event ganda/terbalik aman; PAN tak tersimpan; production tanpa adapter = ECR terkunci.

## E. POS offline wajib (founder 25 Nov malam)

EDG-01: internet putus 4 jam, POS, captain, KDS, expo, cetak, tutup shift, tunai, EDC tetap berfungsi; EDC-05 ikut. Baca PRD EDG-*, `docs/design/edge-cloud-failover.md`, kode `apps/api/src/edge/**` yang sudah ada (jangan bangun ulang), bagian A+B di atas, `1268-pos-wire.md` (layar POS harus bisa memakai alamat API edge atau cloud).
Pertanyaan: topologi mana (POS selalu dilayani edge; atau cloud normal dan pindah ke edge saat putus; atau antrean di browser) yang memenuhi EDG-01 dengan risiko uang paling kecil dan kerja paling sedikit; kartu A dan B mana yang tetap, berubah, atau gugur; matriks fitur (bayar tunai, EDC manual, ECR, QRIS, tiket, refund, void, poin, promo, voucher, DP, pajak/service, denah, PIN, buka/tutup shift, tutup hari, nomor struk, KDS) = jalan / sengaja ditolak saat offline, dengan alasan; data apa yang belum tersinkron; penggabungan saat pulih (nomor, shift, laci, stok, jurnal) tanpa ganda; split-brain; layar saat berpindah; perangkat dan TLS di LAN.
Jangan sampai rugi: ragu = ditolak offline dengan pesan jelas. Keluaran: keputusan, kartu (berkas, jam, urutan, model, tak bertumpuk), test wajib, yang perlu founder.

## Fakta dokumentasi Duitku (docs.duitku.com/api/id lewat Context7 `/websites/duitku_api_id`, 25 Nov)

- Host: sandbox `https://sandbox.duitku.com/webapi/api/merchant/...`, production `https://passport.duitku.com/webapi/api/merchant/...` (`v2/inquiry`, `transactionStatus`).
- Signature HMAC-SHA256 (MD5 usang): inquiry `merchantCode+merchantOrderId+paymentAmount`; callback `merchantCode+amount+merchantOrderId`; status `merchantCode+merchantOrderId`; kunci = apiKey.
- Callback POST form-urlencoded, port 80/443, balas 200. resultCode 00 sukses, 01 gagal. Status 00 sukses, 01 pending, 02 batal. IP: production 182.23.85.14, 103.177.101.190, 182.23.85.{8,9,10,13}, 103.177.101.{184,185,186,189}; sandbox 182.23.85.{11,12}, 103.177.101.{187,188}.
- `transactionStatus` JANGAN dipanggil otomatis berulang: lewat batas = diblok sekitar satu jam.
- expiryPeriod (menit; bawaan/maks): VA 1440/>1440 (nilai merchant dipakai); OVO 10/1440; ShopeePay app 10/60; DANA 1440/1440; QRIS SP 10/60, Nobu 24/1440. TETAP (permintaan diabaikan): kartu 30, LinkAja 24, ShopeePay link 30, OVO link 15.
- Kode: kartu VC; VA BC M2 VA I1 B1 BT A1 AG NC BR S1 DM BV; e-wallet OV SA LF LA DA SL OL; QRIS SP NQ SQ. OV dan SA mendukung void (belum ada API void yang terbaca). SL/OL butuh `accountLink`.
- merchantOrderId maks 50, unik per permintaan; itemDetails wajib sama totalnya dengan paymentAmount.
- Founder: sandbox baru tersedia sesudah domain + deploy. C1 dikerjakan di staging; kode lain sesuai fakta di atas, metode tetap terkunci.

