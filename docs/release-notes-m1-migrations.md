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

## Tambahan batch41

- ws/ws11-shared-3 (dc4a1014, tingkat K, tanpa migrasi baru): F5, F8, F10, legend-3nfc9 dan legend-fr62g (pesanan latihan tidak masuk metrik penjualan). Mock laporan WS-11 mengikuti ketersediaan API.
- Langkah rilis: jalankan `recomputeMetricsDaily` untuk seluruh riwayat (legend-ka1hg), termasuk 6 kode jumlah fasilitas, sebelum laporan WS-11 meninggalkan mock.
- Konflik hanya di `docs/DECISIONS.md` dan `docs/PROGRESS.md` (keep-both). Rantai migrasi tetap 0186 terakhir.
- ws/audit-retention-purge (0187) menyusul sesudah tes migrasi pemilik non-superuser.

## Tambahan batch42

- ws/training-orders-no-journal (1a21d857, legend-gkc6b, tanpa migrasi): pesanan latihan tidak pernah memposting jurnal penjualan atau HPP (consumer jurnal otomatis dan consumer GL stok melewati pesanan latihan).
- Tanpa konflik. Rantai migrasi tetap berujung di 0186.
- ws/audit-retention-purge (0187) masuk batch43 sesudah tes migrasi 0187.

## Tambahan batch43

- 0187 `0187_audit_retention_maintenance` (ws/audit-retention-purge cdb624b9, when 1794266000000): peran `legend_maintenance` NOLOGIN dan dua fungsi SECURITY DEFINER untuk purge retensi audit. `MAINTENANCE_DATABASE_URL` wajib di worker cloud produksi (rahasia, diatur founder).
- 0188 `0188_ai_provider_configs` (ws/ai-provider-tenant 97d02ab6, when 1794267000000): konfigurasi provider AI per tenant.
- 0190 `0190_poll_lease` (ws/doit-pending-poller 895e4312, when 1794269000000): lease untuk poller pembayaran DOIT yang masih pending.
- 0191 `0191_cash_bank_recon` (ws/cash-bank-recon afd6cab3, when 1794270000000): rekening bank, impor mutasi, kasus rekonsiliasi, setoran kas.
- 0198 `0198_equipment_service_reminder` (ws/equipment-maintenance f9afff77, when 1794277000000).
- 0200 `0200_table_links` (ws/table-link 1ead4c4d, memuat 685n 6ef7034d, when 1794279000000): `table_link_groups` dan `table_link_members`. SQL diubah oleh merge train: semua FK dipindah ke dalam `CREATE TABLE` (sebelumnya `ALTER TABLE ... ADD CONSTRAINT`). Tanpa itu migrasi gagal 42501 (tenant context is required) untuk migrator non-superuser, karena validasi FK membaca `outlets` yang FORCE RLS. Pemilik cabang perlu mengonfirmasi. Snapshot tidak berubah dan `db:generate` kosong.
- Tanpa migrasi: ws/ws11-f5-posting-seq 6353e2f8, ws/training-orders-followup ffe54e37, ws/notification-outbox-events 56b8c157, docs/arch-member-loyalty b07b1032 (dokumen saja).
- Rantai: 0186 -> 0187 -> 0188 -> 0190 -> 0191 -> 0198 -> 0200. `prevId` disusun ulang untuk 0188 sampai 0200. Nomor 0189, 0192 sampai 0197 dan 0199 belum dikirim.
- Registry impor: 0187 dan `worker/audit-retention.job.ts` didaftarkan di `data-import-registry.test.ts`.
- Test `accounting-bank-accounts`: cleanup `afterAll` kini hanya menghapus rekening bank miliknya. Tenant fixture dipakai bersama lima file test bank/kas yang jalan paralel, dan `cash_deposits` merujuk rekening itu.
- Flaky `platform-org-api` TEN-06 Q39 (409 saat buat outlet) muncul sekali di run penuh pertama, lulus sendiri dan lulus di run penuh berikutnya. Kartu terpisah sudah ada.

## Gagal lama, bukan regresi

- AIG-01 (kuota harian ai-gateway, sekitar 00:xx WIB, legend-0hyxn).
- TEN-08 white-label e2e (legend-240kd): diperbaiki oleh 789a9a1f di batch ini.
