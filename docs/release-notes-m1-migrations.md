# Catatan rilis M1: migrasi dan urutan deploy

Dikumpulkan oleh merge train. Bagian "Batch ini" sudah ada di cabang ini. Bagian "Batch berikut" menunggu gabungan (rantai 783e3bbf + perbaikan test, lalu 0171 dst).

## Urutan deploy

- Deploy cloud (API) lebih dulu, baru edge. Edge mengirim `receiptSequences=1`; cloud lama menjawab 400.
- Migrasi harus naik berurutan: 0165, 0166, 0167, 0168, 0169, 0170, lalu 0171 dst. Drizzle hanya menjalankan migrasi dengan `when` lebih besar dari yang terakhir diterapkan.

## Batch ini (0167 sampai 0170)

- 0167 `0167_payroll_core` (legend-gfcr): tabel inti payroll, RLS, trigger penjaga. Tidak ada langkah khusus.
- 0168 `0168_expo_pickup_tables` (legend-aiksz): tabel `expo_assignments` dan `pickup_calls`.
- 0169 `0169_payroll_loan_policy` (legend-hjaot, legend-fij0l): tabel `payroll_loan_policies` dan indeks unik `reimbursements_receipt_upload_ref_key` pada `reimbursements`.
  - Migrasi GAGAL bila ada `receipt_upload_ref` ganda (tenant sama, huruf besar/kecil diabaikan). Cek data sebelum deploy dan perbaiki baris ganda.
  - Kolom batas total kasbon terbuka: `max_total_open_idr`, dengan CHECK `max_total_open_idr >= max_principal_idr`. DB integrasi yang sudah menjalankan 0169 versi lama (dd72324c) harus dibuat ulang: 0169 diubah di tempat.
- 0170 `0170_edc_pan_backfill_separators` (legend-0lrkl): MENIMPA teks `edc_transactions.message` tanpa cadangan. Backup DB wajib sebelum deploy. Terdaftar di `MIGRATION_DATA_STATEMENTS`.
- Rantai ulang: idx dan `prevId` snapshot 0167 sampai 0170 disusun ulang di atas 0166. `pnpm db:generate` melapor "No schema changes".

## Batch berikut (menunggu)

- 0171 (`ws/access-perm-backfill`, 0fecec89): tambah izin lewat backfill peran.
- 0172 (`ws/inventory-perm-backfill`, 92d81f70): GAGAL dengan 23503 bila ada baris `production_orders` tanpa resep. Cek dulu dan bereskan.
- 0173 `0173_goods_receipts` (idx 173, when 1794252000000).
- 0174 (when 1794253000000): terdaftar di `MIGRATION_DATA_STATEMENTS` (backfill nomor FA-nnnnn, FORCE RLS dicabut sementara).
- 0175 (when 1794254000000): `pickup_calls.number` smallint menjadi integer. Migrasi tingkat K; snapshot dibuat ulang setelah 0169 sampai 0174.
- 0176 `0176_metrics_daily` (idx 176, when 1794255000000).
  - Kontrak: `availability` kini wajib di `reportResultSchema` dan `metricQueryResponseSchema`.
  - Job `metrics-daily` berjalan tiap 15 menit.
- 0177 (when 1794256000000): backfill butuh user DB superuser (`session_replication_role`) di test.
- 0178 `0178_tenant_claims` (6f2e8d9f, legend-mbd2 dan legend-t57t, when 1794257000000): akses antar tenant (tingkat K).
  - Migrasi berhenti dengan 23505 bila data lama bentrok. Matikan baris yang salah, lalu jalankan ulang.
  - Env baru opsional `PLATFORM_DOMAIN` di `.env.example`.
- 0179 `0179_delivery_platform_sync` (when 1794258000000): 5 kolom `platform_sync_*`.
- b800ae30: sesi impersonate tanpa grant kini dijawab 403 sekali, lalu 401.
- 2dfe842e (legend-6mla dan lainnya): `parseBankCsvAmount` lebih ketat (spasi ribuan ditolak), mock web ws07 ikut berubah.
- 18455b7a (ws/ws11-shared-1, ganti 01aa6ec2 dan a597254c): total HPP pemegang saham (legend-upmn7 Q59), test cakupan outlet (Q60), mock bucket legend-e0fhh. SH-01 kini hijau. Tanpa migrasi.
- 5680dab0 (ws/delivery-staff-resolve, legend-eyqvo, tingkat K): dua commit di atas 2ab2edea, tanpa migrasi.

## Tambahan batch39

- ws/auth-audit-trail fd953712 (5bb9758f..fd953712, tingkat K, tanpa migrasi): `TRUST_PROXY` wajib diatur di belakang proxy, karena limiter login-challenges memakai IP klien. Tanpa itu semua klien terlihat satu IP.
- Migrasi 0171, 0172, 0177 dan 0178 berisi UPDATE data (backfill izin peran, token verifikasi domain, tautan storage). Semuanya idempotent dan terdaftar di `MIGRATION_DATA_STATEMENTS`.
- `0178_tenant_claims.sql` diubah oleh merge train: `tenant_integrations` diberi `NO FORCE ROW LEVEL SECURITY` sebelum blok DO pengecekan duplikat dan `FORCE ROW LEVEL SECURITY` sesudahnya. Tanpa itu migrasi gagal 42501 (tenant context is required) untuk migrator non-superuser. Pemilik cabang perlu mengonfirmasi.

## Tambahan batch40

- 0180 (ws/kds-issues-station 038d8201, tingkat K, when 1794259000000): tabel `order_issues`.
- 0181 (a92b9bac, when 1794260000000): tabel `sales_targets` dan backfill `recomputeMetricsDaily` untuk seluruh riwayat (legend-ka1hg). Jalankan backfill sebelum pembaca WS-11 dipakai.
- 0184 (34f0dc53, 6538c932, when 1794263000000): tabel `kitchen_capacity_rules`.
- 0186 (b10f22dd, legend-bsw9, when 1794265000000): kolom `stock_ledger.posting_seq`. Migrasi memakai ACCESS EXCLUSIVE saat update, jadi deploy saat sepi.
- 42dded50: `ip_hash` IPv6 kini digest /64. Jendela AUTH-04 (reset) mulai ulang sekali saat deploy.
- 690eaf41: status HTTP kode error inventori disatukan. `PO_LINE_MISMATCH` dan `THREE_WAY_MATCH_INVALID_INPUT` berubah 409 menjadi 422. `INSUFFICIENT_STOCK` lewat translator tetap 409. `WASTE_MEDIA_NOT_FOUND` (dari 92d81f70) ditambahkan ke peta status (422, sama dengan service dan test) dan peta pesan.
- ec37dc36 dan 8f30eb0d: snapshot HPP per baris pesanan. HPP tidak dikirim ke kasir lewat DTO pesanan POS.
- cff27b49: 4 file test webhook lama ikut dijalankan di gate ini (hijau).
- Test `stock-ledger-posting-seq-migration` kini mencari snapshot sebelum 0186, bukan mengasumsikan 0170.
- Nomor 0182, 0183 dan 0185 belum dikirim. Celah idx ini wajar untuk drizzle.

## Gagal lama, bukan regresi

- AIG-01 (kuota harian ai-gateway, sekitar 00:xx WIB, legend-0hyxn).
- TEN-08 white-label e2e (legend-240kd): diperbaiki oleh 789a9a1f di batch ini.
