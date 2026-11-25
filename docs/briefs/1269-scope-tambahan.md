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
