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
- ws11-gl-parity SH-01 (acceptance test baris 661) merah, menunggu keputusan founder legend-upmn7.

## Gagal lama, bukan regresi

- AIG-01 (kuota harian ai-gateway, sekitar 00:xx WIB, legend-0hyxn).
- TEN-08 white-label e2e (legend-240kd): diperbaiki oleh 789a9a1f di batch ini.
