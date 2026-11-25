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
