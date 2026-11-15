# Catatan rilis M1: migrasi dan urutan deploy

Dikumpulkan oleh merge train. Bagian "Batch ini" sudah ada di cabang ini. Bagian "Batch berikut" menunggu gabungan (rantai 783e3bbf + perbaikan test, lalu 0171 dst).

## Urutan deploy

- Deploy cloud (API) lebih dulu, baru edge. Edge mengirim `receiptSequences=1`; cloud lama menjawab 400.
- Migrasi harus naik berurutan: 0165, 0166, 0167, 0168, 0169, 0170, lalu 0171 dst. Drizzle hanya menjalankan migrasi dengan `when` lebih besar dari yang terakhir diterapkan.

### Backfill riwayat metrik WS-11 (legend-ka1hg)

Setelah migrasi dan API terbaru terpasang, jalankan backfill sebelum pembaca laporan WS-11 dipakai. Jalankan dari root checkout rilis dengan konfigurasi database API untuk lingkungan tujuan. Pilih `--from` sebagai tanggal bisnis paling awal yang perlu dimasukkan (format `YYYY-MM-DD`); untuk seluruh riwayat, gunakan tanggal bisnis sumber paling awal, bukan tanggal deploy.

```bash
pnpm --filter @starter/api metrics:backfill -- --from 2020-01-01 --dry-run
pnpm --filter @starter/api metrics:backfill -- --from 2020-01-01
```

Ganti tanggal contoh sesuai riwayat sumber. Untuk memeriksa dan memproses satu tenant lebih dulu, tambahkan `--tenant <slug>` pada kedua perintah. Tanpa `--tenant`, skrip memproses seluruh tenant. `--dry-run` hanya menghitung rencana kerja dan tidak menulis `metrics_daily`.

Rentang berjalan dari `--from` sampai tanggal bisnis saat proses dimulai, inklusif, memakai zona waktu dan batas pergantian hari masing-masing outlet. Hari bisnis yang masih berjalan tetap mengikuti aturan estimasi/finalitas metrik yang ada. Tanggal tidak valid atau di masa depan ditolak. Outlet yang sudah ditutup tetap disertakan untuk riwayatnya.

Skrip memanggil `recomputeMetricsDaily` per tenant, outlet, dan hari secara berurutan; halaman tenant dan outlet dibatasi 25 baris. Hari tanpa sumber data dilewati, sehingga nilai metrik lama pada hari itu tidak diubah. Log hanya memuat ID tenant dan angka; jangan menambahkan nama pelanggan, nilai rahasia, atau connection string ke catatan operator. Kode keluar `0` berarti selesai, `1` berarti ada kegagalan pemrosesan, dan `2` berarti masukan ditolak. Periksa `failedDays`; bila ada kegagalan, selesaikan penyebabnya lalu jalankan ulang dengan tanggal dan tenant yang sama. Backfill idempoten, sehingga pengulangan aman dan tidak menggandakan hasil. Jangan menghapus `metrics_daily` untuk mengulang proses. Langkah ini juga mengisi enam kode jumlah fasilitas yang disyaratkan batch41.

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

## Tambahan batch44

- 0201 `0201_brand_logo_storage` (ws/brand-logo-upload 52f4242a, when 1794280000000).
- 0202 `0202_bill_splits` (ws/split-bill c6916247, when 1794281000000): `bill_splits` dan FK dari `payment_intents`.
- 0203 `0203_member_loyalty_ledger` (ws/ws08-111j e15950fe, when 1794282000000): buku besar poin, profil member, FK `orders_customer_profile_fk`. **Jalankan 0203 di jendela sepi: migrasi ini mengambil ACCESS EXCLUSIVE pada `orders`.**
- 0204 `0204_hris_scheduling` (ws/hr-scheduling 88cc626e, when 1794283000000): **dinomori ulang dari 0199 ke 0204.** Alasannya: `when` lama (1794278000000) sudah di bawah 0200 yang terpasang, jadi Drizzle tidak akan menjalankannya. Selain itu `drizzle-kit generate` membandingkan dengan snapshot berkas bernomor tertinggi, sehingga berkas bernomor lebih rendah yang ditaruh sesudah 0205 diabaikan dan `db:generate` ingin membuat ulang tabelnya. Berkas SQL, snapshot dan tag jurnal sudah diganti nama.
- 0205 `0205_purchase_return_posting` (ws/purchase-return-posting 58d79c20, when 1794284000000): akun 5104 Pembelian Langsung (Kas Kecil) dan mapping `petty_purchase_expense` untuk entitas yang sudah punya mapping. **Flag `PURCHASE_RETURN_POSTING_ENABLED` default mati; jangan dinyalakan.**
- 0206 `0206_hris_lifecycle_kpi` (ws/hr-lifecycle-kpi 5f864932, when 1794285000000): `role_assignments_window_check` dilonggarkan dari `>` ke `>=`.
- 0207 `0207_loyalty_rewards_missions` (ws/m4p5-rewards 911846ad, when 1794286000000).
- 0208 `0208_supplier_return_petty` (ws/supplier-return-petty f2bd63f5, when 1794287000000): retur pembelian, kas kecil, tiga kode izin baru untuk peran template.
- Nomor 0209 sampai 0212 dipesan untuk cabang yang belum selesai. Jangan dipakai.
- Rantai: 0200 -> 0201 -> 0202 -> 0203 -> 0204 -> 0205 -> 0206 -> 0207 -> 0208. `prevId` disusun ulang untuk semuanya. `pnpm db:generate` kosong.
- SQL diubah oleh merge train: semua FK dari tabel baru ke tabel yang sudah ada (mis. `outlets`, `employees`, `tenants`) di 0204, 0206, 0207, 0208 dipindah ke dalam `CREATE TABLE`. Migrator non-superuser dengan FORCE RLS gagal 42501 "tenant context is required" pada `ALTER TABLE ... ADD CONSTRAINT` yang membaca tabel ber-RLS (sama seperti 0200). DDL akhirnya setara; snapshot tidak berubah.
- Registry impor: 0205 dan 0208 didaftarkan di `data-import-registry.test.ts`.
- Tanpa migrasi: ws/tax-snapshot-facility 09a124b2.
- Perbaikan isi di luar konflik: label `loyalty_reward` ("Hadiah poin") di i18n member dan promo, dan default mock web ws08 (`voucherCode`, `perCustomerLimit`, `redemptionValidDays`) mengikuti kontrak m4p5. Test `platform-access-db` mengikuti batas `>=` dari 0206; test `provisioning-race` kini mengharapkan 64 akun (5104).
- 0217 `0217_profit_share` (dulu 0219 di ws/profit-share, legend-2ljb, tingkat K, idx 217, when 1794298000000): tabel bagi hasil dan FK komposit `profit_entity_id` di `shareholder_document_files` dan `shareholder_documents`. GAGAL dengan pesan `0217: ...` bila salah satu tabel dokumen sudah berisi baris, karena `profit_entities` baru dan kosong. Cek dulu: `SELECT (SELECT count(*) FROM shareholder_document_files) AS files, (SELECT count(*) FROM shareholder_documents) AS documents;` Keduanya harus 0, kalau tidak hapus atau pindahkan barisnya dulu.

## Tambahan batch45

- Tanpa migrasi baru. `pnpm db:generate` kosong. Urutan merge: `ws/ia54l-claim-after-close` e4efc823 (legend-ia54l), `ws/worker-audit-writer` 5391163c (berisi `ws/arj6-auto-clearance`; legend-arj.6, legend-j88cz), `ws/msqvi-points-journal` babb3174 (legend-msqvi). Tanpa konflik, `docs/PROGRESS.md` tergabung otomatis.
- Worker audit writer: sebelum deploy, jalankan query 3 di `docs/runbooks/worker-audit-writer-m1-window.md` (persetujuan lewat tenggat). Deploy di jendela sepi bersama 0203: sapuan pertama mengedarkan semua persetujuan kedaluwarsa sekaligus.
- Jurnal poin: tenant lama perlu `pnpm db:backfill-defaults` (akun 4105). Jurnal poin tetap tidak dinyalakan sampai `legend-kbbma` selesai dan akuntan founder konfirmasi (`docs/DECISIONS.md` "WS-08: loyalty points journal, PSAK 72").
- Perbaikan isi di luar konflik: `provisioning-race.test.ts` (legend-usa4b) menunggu 64 akun bagan standar; kini 65 sesudah akun 4105.
- Flaky `platform-org-api` TEN-06 Q39 (409 saat buat outlet, kartu legend-23tbw) gagal di run penuh 3 dan 4, lulus sendiri dan lulus di run penuh 5.

## Tambahan legend-8s992 (aturan bagi hasil founder, migrasi 0218)

- 0218 `0218_profit_share_unabsorbed` (dulu 0221; batch47a dinomori ulang, idx 218, when 1794299000000): kolom `distribution_runs.unabsorbed_idr`, trigger totals run koreksi (boleh kurang dari 10000 bp), trigger run koreksi hanya menargetkan run reguler, dan backfill izin `profit_share.share_allocation.change`.
- Backfill izin hanya ke template `owner` dan `finance` di semua tenant. Role kustom yang memegang `profit_share.registry.manage` TIDAK di-backfill (sama dengan keputusan krvk7): pemilik tenant harus menambahkan izin "Ubah porsi saham pemegang saham" ke role kustom itu, kalau tidak mereka kena 403 saat membuat, mengubah, atau mengajukan versi porsi.
- Perubahan perilaku: klaw-bek yang melebihi yang sudah dibayarkan tidak lagi ditolak seluruhnya; dibatasi per pemegang saham dan sisanya dicatat di `unabsorbed_idr`. Ditolak 422 `ADJUSTMENT_EXCEEDS_PAID` hanya bila tidak ada yang bisa diserap.

## Tambahan legend-ideif (pepper PIN staf di edge)

- Migrasi `0225_edge_staff_pin_peppers`: tabel `edge_staff_pin_peppers` (RLS tenant dan outlet). Nomor tetap 0225 di batch47a (when 1794306000000). `pnpm db:generate` kosong.
- Urutan: cloud dulu (query `peppers`), lalu edge. Env cloud baru: `STAFF_PIN_PEPPER_CURRENT_VERSION` (default 1).
- Edge terpasang: hapus `STAFF_PIN_PEPPER` dari env edge SEBELUM restart (edge menolak jalan bila masih ada), outlet online agar sinkron pertama mengirim pepper tenant. Sebelum sinkron itu PIN di edge ditolak tanpa menaikkan hitungan gagal. Langkah lengkap dan rotasi: `docs/deployment.md` "Staff PIN pepper on edge nodes".

## Gagal lama, bukan regresi

- AIG-01 (kuota harian ai-gateway, sekitar 00:xx WIB, legend-0hyxn).
- TEN-08 white-label e2e (legend-240kd): diperbaiki oleh 789a9a1f di batch ini.

## Tambahan batch46

Migrasi baru (idx 209 sampai 216, rapat, `when` naik). Penomoran akhir berbeda dari nama di cabang asal:

| Akhir | Tag                                | Nama lama di cabang | Cabang                   | `when`        |
| ----- | ---------------------------------- | ------------------- | ------------------------ | ------------- |
| 0209  | `0209_crm_feedback_segments`       | sama                | ws/ts50-customer360      | 1794288000000 |
| 0210  | `0210_loyalty_tiers_referrals`     | sama                | ws/3zd1-tiers-expiry     | 1794289000000 |
| 0211  | `0211_platform_payment_gateways`   | sama                | ws/gateway-plan-revoke   | 1794290000000 |
| 0212  | `0212_failed_item_recovery`        | 0214                | ws/swap-stock            | 1794293000000 |
| 0213  | `0213_facility_entitlement_ledger` | 0215                | ws/facility-entitlements | 1794294000000 |
| 0214  | `0214_order_pacing`                | 0216                | ws/kitchen-load-admin    | 1794295000000 |
| 0215  | `0215_hris_attendance`             | 0217                | ws/storage-wire          | 1794296000000 |
| 0216  | `0216_wifi_quota_engine`           | 0218                | ws/wifi-edge             | 1794297000000 |

- Nomor 0217 dan seterusnya dipakai batch47a (lihat bagian "Tambahan batch47a" di bawah).
- Rantai: 0208 -> 0209 -> ... -> 0216. `prevId` tiap snapshot disambung ulang dan tiap snapshot berisi skema kumulatif. `pnpm db:generate` kosong.
- Tanpa migrasi: `ws/hris-loan-perm`, `ws/loyalty-training-lookup`, `ws/az-flow-y` (hanya test e2e), `ws/flaky-ten06` (hanya test).
- **SQL diubah oleh merge train (batch47a, legend-436yt):** 0210, 0212, 0213, 0214 dan 0216 kini menulis FK tabel baru inline di `CREATE TABLE` (tanpa angkat NO FORCE/FORCE). Hanya FK yang anaknya tabel lama (`customer_profiles_tier_fk` di 0210, `order_issues_replacement_order_item_fk` di 0212, FK `wifi_policies` bila ada) tetap ALTER dengan NO FORCE/FORCE sempit. Skema akhir identik dengan versi lama (dibandingkan lewat pg_constraint, relforcerowsecurity, kolom, indeks, trigger, policy: 0 beda). Migrator production tetap BYPASSRLS; AccessExclusive tinggal pada tabel anak lama yang disebut, induk lain hanya terblokir tulis (ShareRowExclusive). Jalankan di jendela sepi.
- Pembaruan nama: komentar di `apology-vouchers.ts/.custom.sql`, `facility-entitlement.custom.sql`, `facility-entitlement-migration.test.ts`, `kds-pacing.custom.sql` dan baris `docs/PROGRESS.md` ikut dinomori ulang.

Perlu backfill atau konfigurasi:

- **Gateway Duitku (0211):** butuh kunci sandbox dari founder, belum ada. Tanpa kunci gateway tidak bisa diaktifkan.
- **Storage PDF:** upload PDF ditolak 503 di production selama scanner masih noop (`ws/storage-wire`).
- **Jurnal koreksi otomatis:** perilaku jurnal koreksi berjalan otomatis sesudah deploy (tidak ada tombol); periksa jurnal koreksi pertama.
- Tier loyalti dan job harian tier/kedaluwarsa poin (0210) berjalan di relay worker per tenant per hari.

Perilaku berubah:

- `ws/swap-stock`: swap mengembalikan stok lini lama dan menarik stok pengganti; lini swap gratis dikeluarkan dari laporan penjualan.
- Kuota Wi-Fi harian (0216) bergerak mengikuti pembayaran dan refund order member.
- krvk7 (peran kustom tanpa backfill) tidak termasuk batch ini.

Perbaikan isi di luar konflik: lihat laporan merge train batch46 (FORCE RLS di atas, nama migrasi, test hitungan bila ada).

## Tambahan batch47a (penomoran ulang, FK inline)

Nomor sementara dari cabang dinomori ulang rapat sesudah 0216, urut merge. `when` naik 1000000 per migrasi; snapshot dibuat ulang dari skema gabungan; `pnpm db:generate` kosong sesudah tiap merge.

| Akhir | Tag                               | Nomor lama di cabang | Cabang                                  | `when`        |
| ----- | --------------------------------- | -------------------- | --------------------------------------- | ------------- |
| 0217  | `0217_profit_share`               | 0219                 | ws/profit-share                         | 1794298000000 |
| 0218  | `0218_profit_share_unabsorbed`    | 0221                 | ws/8s992-profit-rules                   | 1794299000000 |
| 0219  | `0219_profit_share_carry`         | 0224                 | ws/lzvh0-unabsorbed-carry               | 1794300000000 |
| 0220  | `0220_payment_refund_order_issue` | 0222                 | ws/94q2l-impl                           | 1794301000000 |
| 0221  | `0221_k2l_member_signin_identity` | 0220                 | ws/k2l-followup                         | 1794302000000 |
| 0222  | `0222_wa_login_reply_policies`    | 0226                 | ws/dn4-wa-replies                       | 1794303000000 |
| 0223  | `0223_swap_return_park`           | 0228                 | ws/nzbi8-swap-stock-park                | 1794304000000 |
| 0224  | `0224_wifi_quota_apply_queue`     | 0220                 | ws/oeqme-wifi-queue                     | 1794305000000 |
| 0225  | `0225_edge_staff_pin_peppers`     | 0225                 | ws/ideif-edge-pepper                    | 1794306000000 |
| 0226  | `0226_hris_edge_replication`      | 0227                 | ws/hwn02-hris-edge-schema (lewat ye4j1) | 1794307000000 |
| 0227  | `0227_edge_selfie_rejected_at`    | 0233                 | ws/hubzo-selfie-worker                  | 1794308000000 |
| 0228  | `0228_tax_reports`                | 0235                 | ws/gmww-accounting-deltas               | 1794309000000 |

- Tanpa migrasi baru: ws/0w2wy-docs-storage, ws/n6fek-recovery-refund-metrics, ws/mz15j-paid-check, ws/eirhm-menu-print-cleanup, ws/5tmye-whitelabel-flaky, ws/hris-edge-design, ws/cku1m-qr-v2, ws/tkycp-people-pull. Tidak ikut: ws/u37u3 (menunggu review founder), tip j6cyb dan i83ls. ws/svy91-edge-ops (94db22c1, tanpa migrasi) ikut.
- `ws/94q2l-impl` mengubah `failed_item_recovery` di tempat; di m1 berkas itu `0212_failed_item_recovery.sql`, dan versi m1 (FK inline) dipakai. m1 tidak tercatat pernah diterapkan ke DB bersama, jadi ubah di tempat aman; kalau ternyata sudah diterapkan ke satu DB, DB itu harus dibuat ulang atau diperbaiki manual.
- 0217 GAGAL (`0217: ...`) bila `shareholder_document_files` atau `shareholder_documents` sudah berisi baris (lihat catatan 0217 di atas).
- 0218 mem-backfill izin `profit_share.share_allocation.change` ke template owner dan finance (lihat bagian legend-8s992).
- Test yang bergantung nomor: `edge-hris-migration-0226.test.ts` (dulu `-0227`, journal dipotong di idx 225), `profit-share-permission-backfill-migration.test.ts`, `profit-share-carry-migration.test.ts`, `data-import-registry.test.ts`.

## Tambahan batch48a (penomoran ulang 0229 sampai 0234)

Nomor sementara dari cabang dinomori ulang rapat sesudah 0228, urut merge. `when` naik 1000000 per migrasi mulai 1794310000000; snapshot dibuat ulang dari skema gabungan (0229 dibangun dari 0230 dengan mencabut delta forward migration); `pnpm db:generate` kosong sesudah tiap merge. m1 belum pernah diterapkan ke DB bersama (`docs/deployment.md`), jadi 0229 dan forward migration 0230 dipakai apa adanya, tidak digabung.

| Akhir | Tag                                | Nomor lama di cabang                                              | Cabang               | `when`        |
| ----- | ---------------------------------- | ----------------------------------------------------------------- | -------------------- | ------------- |
| 0229  | `0229_order_issue_refund_rejected` | 0229 (`when` lama 1794308000000 lebih kecil dari 0228, dinaikkan) | ws/i83ls-fix         | 1794310000000 |
| 0230  | `0230_order_issue_charge_cash`     | 0244                                                              | ws/i83ls-fix         | 1794311000000 |
| 0231  | `0231_tax_report_revisions`        | 0242                                                              | ws/r3i8w-tax-reports | 1794312000000 |
| 0232  | `0232_pos_acting_staff`            | 0243                                                              | ws/aruta-pos-pin     | 1794313000000 |
| 0233  | `0233_mfa_recovery_codes`          | 0239                                                              | ws/omp4-mfa-recovery | 1794314000000 |
| 0234  | `0234_uom_is_system`               | 0245                                                              | ws/ie6m-uom-write    | 1794315000000 |

- Tanpa migrasi baru: ws/94q2l-impl (hanya kode refund), ws/tct8-config-codecs. omp4 dan ie6m masing-masing hanya satu migrasi (nomor 0240 dan 0246 pada brief tidak ada).
- **SQL diubah oleh merge train:** 0230 kini mengangkat FORCE RLS `order_issue_charges` dan `cash_movements` sebelum menambah FK, lalu memulihkannya di akhir (pola 2, `docs/plan/contracts.md`): tanpa itu migrasi gagal untuk pemilik tabel non-superuser (`edge-received-events-migration.test.ts`). 0232 menulis semua FK `pos_acting_staff` inline di `CREATE TABLE` (pola legend-436yt), tanpa angkat NO FORCE/FORCE; skema akhir identik.
- Perubahan kode di luar nomor: `device-pin.service.ts` (`attemptStaffPinVersioned` dari aruta memakai pepper per generasi dari ideif), `order-recovery-refund-amount.ts` (pro-rata kumulatif 94q2l; `lineShareSplit` tetap diekspor untuk tagihan swap), `order-recovery-refund.ts` (import `inArray` dan `isNull`).
- Test yang bergantung nomor: `order-issue-charge-cash-migration.test.ts` (idx 230), `accounting-tax-report-revisions.test.ts` (journal dipotong di idx 230), `uom-is-system-migration.test.ts` (dipotong di idx 233), `inventory-uom-backfill-migration.test.ts`.

## Tambahan batch48b (penomoran ulang 0235 sampai 0241)

Nomor sementara dari cabang dinomori ulang rapat sesudah 0234, urut merge. `when` naik 1000000 per migrasi mulai 1794316000000; snapshot dibuat ulang dari skema gabungan dengan `scripts/migration-renumber.mjs` (`node scripts/migration-renumber.mjs check --from-idx 235` memeriksa nomor, `when` dan rantai `prevId`). `db:generate` kosong sesudah tiap merge.

| Akhir | Tag                                        | Nomor lama di cabang | Cabang                                                        | `when`        |
| ----- | ------------------------------------------ | -------------------- | ------------------------------------------------------------- | ------------- |
| 0235  | `0235_staff_pin_proofs`                    | 0241                 | ws/u7g9w-pin-proof                                            | 1794316000000 |
| 0236  | `0236_user_pin_throttle`                   | 0258                 | ws/jmsdx-pepper (memuat vfj7z)                                | 1794317000000 |
| 0237  | `0237_table_claim_points`                  | 0236                 | ws/split-claim-hide (juga ada di claim-payer-secret dan cpq2) | 1794318000000 |
| 0238  | `0238_claim_payer_secret`                  | 0255                 | ws/claim-payer-secret                                         | 1794319000000 |
| 0239  | `0239_profit_share_recipient_versions`     | 0252                 | ws/tm6pp-seed-policy (memuat 33im6)                           | 1794320000000 |
| 0240  | `0240_share_version_approval`              | 0256                 | ws/tm6pp-seed-policy                                          | 1794321000000 |
| 0241  | `0241_shareholder_version_approval_policy` | 0259                 | ws/tm6pp-seed-policy                                          | 1794322000000 |

- Tanpa migrasi baru: ws/ptn11-acting-staff-w2, ws/kxoyf-pos-swap, ws/w5by9-expiry-fifo. ws/cpq2-qr-read-models sudah termuat lewat split-claim-hide (migrasi `table_claim_points` yang sama di tiga cabang, isinya identik, satu salinan dipakai).
- **SQL diubah oleh merge train:** 0239 memindahkan dua FK `shareholder_recipient_versions` (tenant dan shareholder) ke dalam `CREATE TABLE` (pola 1, `docs/plan/contracts.md`). Pengangkatan dan pemulihan FORCE RLS di 0239, 0241 dan 0217 sudah dari cabang asal dan dipertahankan. Temuan architect: backfill 0239 juga mematikan sementara trigger `distribution_lines_totals_trg` (trigger tertunda dari 0217), karena kalau tidak dia berjalan saat commit tanpa konteks tenant dan membatalkan migrasi untuk pemilik non-superuser yang sudah punya baris `distribution_lines`; nama pengaturan sementara di 0237 kini `legend.lock_timeout_before_0237`.
- **0239 diedit di tempat** (Codex 405): backfill lama menyalin login shareholder saat migrasi ke `distribution_lines.recipient_user_id`, padahal login itu bisa sudah pindah dari penerima asli. Kini baris lama tetap `recipient_user_id` NULL; semua yang SUDAH DIBAYAR (`payment_status = 'paid'`), dengan atau tanpa login pada shareholder-nya kini, ditandai `recipient_unverified = true` (kolom baru, indeks parsial) dan tidak terlihat oleh login mana pun sampai Owner merekonsiliasi. Baris belum dibayar tidak ditandai (toh belum bisa dibaca, dan tanda itu akan menghalangi penerima pembayarannya): tetap NULL dan mendapat login saat dibayar seperti baris baru. Trigger `distribution_lines_guard` mendapat satu cabang UPDATE untuk rekonsiliasi itu. Database dev dan test yang sudah menerapkan 0239 lama harus di-reset. m1 belum pernah diterapkan ke database bersama.
- **0217 diedit di tempat** oleh ws/33im6 (isi ulang `profit_entities` dari id lama dokumen; FORCE RLS `outlets` dan `legal_entities` diangkat lalu dipulihkan). Database dev dan test yang sudah menerapkan 0217 lama harus di-reset. m1 belum pernah diterapkan ke database bersama.
- ws/claim-payer-secret: web dan API harus dirilis bersamaan (createGuestPayment untuk bagian split wajib membawa `payerSecret`).
- Perubahan kode di luar nomor: `device-pin.service.ts` dan `device-pin.routes.ts` (pepper per outlet, reset dan rehash dari jmsdx digabung dengan bukti versi PIN dan cek outlet kasir aktif dari u7g9w/aruta), `packages/shared/src/qr-order/guest.ts` (`payerSecret` bersama `requireBankForVaOnly`), `qr-order.service.ts` (satu impor `orderIssueCharges` dan `orderIssues`), `app.ts` (CORS membawa `X-Acting-Staff`, `X-Device-Token`, `X-Pin-Proof`).
- Test dan docs yang bergantung nomor: `shareholder-version-policy-seed.test.ts` (idx 241, `when` 1794322000000), `data-import-registry.test.ts` (entri baru untuk 0217, 0239, 0241), komentar di `seed-dev-tenant.ts`, `access.service.ts`, `approval.ts`, `qr-order.ts`.
- Lint dibersihkan setelah merge: impor tak terpakai di `open-bill.routes.ts` dan `order-recovery-charge-pos.ts`, tipe `any` di `order-issue-charge-cash-migration.test.ts`, variabel tak terpakai di `tests/ws07-profit-share-carry.test.mjs`.

## Tambahan batch48c (penomoran ulang 0242 sampai 0246)

Nomor sementara dari cabang dinomori ulang rapat sesudah 0241, urut merge. `when` naik 1000000 per migrasi mulai 1794323000000; snapshot dibuat ulang dari skema gabungan dengan `scripts/migration-renumber.mjs` (`node scripts/migration-renumber.mjs check --from-idx 242`). `db:generate` kosong sesudah tiap merge.

| Akhir | Tag                            | Nomor lama di cabang | Cabang                  | `when`        |
| ----- | ------------------------------ | -------------------- | ----------------------- | ------------- |
| 0242  | `0242_tenant_config_templates` | 0259                 | ws/tenant-config-export | 1794323000000 |
| 0243  | `0243_tenant_config_rls`       | 0260                 | ws/tenant-config-export | 1794324000000 |
| 0244  | `0244_edge_print`              | 0261                 | ws/print-agent          | 1794325000000 |
| 0245  | `0245_edge_print_rls`          | 0262                 | ws/print-agent          | 1794326000000 |
| 0246  | `0246_payslip_pins`            | 0257                 | ws/hris-pii-pin         | 1794327000000 |

- Tanpa migrasi baru: ws/fe-small-tests, ws/u37u3-platform-sync, ws/fe-badge-theme, ws/ws01-staff-access, ws/ebt9f-me-outlets, ws/outlet-context-rollout, ws/duitku-codex-fix, ws/s5jup-duitku, ws/refund-recovery-fix.
- **SQL diubah oleh merge train (temuan architect):** 0244 memindahkan lima FK ke `outlets` dan 0246 memindahkan dua FK ke `employees` ke dalam `CREATE TABLE` (pola 1, `docs/plan/contracts.md`); tanpa itu migrasi gagal untuk pemilik tanpa BYPASSRLS (`tenant context is required`). 0245 menambah `REVOKE DELETE, TRUNCATE` pada `edge_print_alerts` dan `edge_print_jobs` (kode tidak pernah menghapus baris di sana). Komentar penomoran di `0245` dan `edge-print.custom.sql` diperbarui.
- **Perubahan kode karena tabrakan semantik:** PIN slip gaji (hris-pii-pin) ditulis terhadap `staffPinPepper(tenant, version)` lama; di batch48b pepper menjadi per outlet. Slip gaji milik karyawan, bukan outlet, jadi `device-pin-pepper.ts` mendapat `payslipPinPepper(tenant, version)` (per tenant, label HKDF sendiri `legend:payslip-pin-pepper:v{n}:{tenant}`, hanya di cloud) dan `payslip-pin.service.ts` memakainya. PIN slip gaji belum pernah disimpan di database bersama.
- **PERTANYAAN TERBUKA untuk CTO:** `packages/shared/src/platform/config-codecs.ts` (legend-tct8) dan `configSectionItemSchemas` di `config.ts` (tenant-config-export) menggambarkan item roles, approval_policies, dan chart_of_accounts dalam dua bentuk (cabang ekspor memakai diskriminator `kind`, codec tidak). Sementara itu `configBundleSchema` menjalankan pemeriksaan codec hanya untuk bagian yang itemnya tanpa `kind`; bagian dengan `kind` diperiksa oleh skema ketat di batas server. Satu bentuk perlu dipilih.

## Tambahan batch48d (penomoran ulang 0247 sampai 0249)

Nomor sementara dinomori ulang rapat sesudah 0246, urut merge. `when` naik 1000000 per migrasi mulai 1794328000000. `pnpm db:generate` kosong dan `node scripts/migration-renumber.mjs check --from-idx 242` hijau setelah tiap merge.

| Akhir | Tag                                            | Nomor lama di cabang | Cabang                                                                      | `when`        |
| ----- | ---------------------------------------------- | -------------------- | --------------------------------------------------------------------------- | ------------- |
| 0247  | `0247_sole_owner_self_approval`                | 0270                 | ws/owner-self-approve (juga termuat di ws/inbox-self-approve dan ws/ps-405) | 1794328000000 |
| 0248  | `0248_payroll_reseal_keys`                     | 0272                 | ws/snhxw-payroll-keys                                                       | 1794329000000 |
| 0249  | `0249_backfill_marketing_opt_in_from_consents` | 0242                 | fix/codex-411-loyalty-consent                                               | 1794330000000 |

- Tanpa migrasi baru: ws/tenant-config-followups, ws/outlet-followups, ws/duitku-406, fix/codex-418-pin, fix/codex-414-hris-attendance, fix/codex-415-wifi, ws/ekxy2-void-line (memuat fix/codex-419-table-merge).
- 0248 tidak punya perubahan skema (hanya GRANT kolom dan ganti fungsi), jadi snapshot 0248 disalin dari 0247 dengan `id`/`prevId` baru dan entri jurnal ditulis manual. Sama untuk 0249 (data saja).
- **SQL diubah oleh merge train:** 0249 (backfill `customer_profiles.marketing_opt_in`) dibungkus `NO FORCE` / `FORCE ROW LEVEL SECURITY` untuk `consents` dan `customer_profiles`, pola 0068/0116/0140/0145/0241: migrator pemilik tabel biasa (tanpa BYPASSRLS) akan kena 42501 tanpa `app.tenant_id`. Entri baru di `data-import-registry.test.ts`.
- **0239 diedit di tempat oleh ws/ps-405:** kolom `distribution_lines.recipient_unverified` dan indeksnya ditambah ke 0239; baris lama yang sudah dibayar ditandai `recipient_unverified` dan hanya Owner tenant yang bisa menetapkan penerimanya satu kali (dengan baris audit). Snapshot 0239 sampai 0248 diberi kolom dan indeks yang sama. **Database dev/test yang sudah menerapkan 0239 lama harus di-reset** (migrasi tidak dijalankan ulang); catatan batch48b/48c menyebut m1 belum pernah diterapkan ke database bersama, jadi edit di tempat aman; CTO tetap cek tabel migrasi staging dan produksi untuk 0239 sebelum rilis. Bila 0239 lama sudah jalan di sana, tulis migrasi 0250 (kolom, indeks, guard, flag) alih-alih mengandalkan edit ini (temuan architect batch48d).
- **Cabang uang (duitku-406, ps-405):** tidak ada konflik di file kode; hanya docs. Perilaku tidak diubah saat merge.
- **Ditahan, tidak digabung:** ws/pti5r-promo-refund (kartu legend-fwe4l dan second opinion Codex refund), semua cabang WhatsApp (lgfru, s5rgo, 9h2oj, w8dfz.*).

## Tambahan batch48g (penomoran ulang 0255 sampai 0259)

Migrasi 0250 sampai 0254 (batch48f) ada di entri PROGRESS batch48f.

| Akhir | Tag                                      | Nomor lama di cabang | Cabang                                | `when`        |
| ----- | ---------------------------------------- | -------------------- | ------------------------------------- | ------------- |
| 0255  | `0255_drop_payslip_pin_reset_challenges` | 0273                 | ws/9h2oj-wa-reset (juga memuat ur82k) | 1794336000000 |
| 0256  | `0256_approved_leaves_on`                | 0276                 | ws/5nt2z-leave-partial                | 1794337000000 |
| 0257  | `0257_flag_attendance_for_leave`         | 0277                 | ws/5nt2z-leave-partial                | 1794338000000 |
| 0258  | `0258_leave_clash_backfill`              | 0278                 | ws/5nt2z-leave-partial                | 1794339000000 |
| 0259  | `0259_hpp_recompute`                     | 0278                 | ws/2qq-hpp-recompute                  | 1794340000000 |

- 0256, 0257, 0258 tidak punya perubahan skema: snapshot disalin dari 0255 dengan `id`/`prevId` baru dan entri jurnal ditulis manual. `db:generate` kosong.
- **SQL diubah oleh merge train:** 0259, tujuh FK `menu_costs` dipindah ke dalam `CREATE TABLE` (outlets FORCE RLS; `ADD CONSTRAINT` oleh migrator non-superuser gagal 42501).
- 0257 dan 0258 berisi INSERT/UPDATE dan terdaftar di `MIGRATION_DATA_STATEMENTS` (`data-import-registry.test.ts`).
- `hpp_outlet_state` (0259) hanya RLS tenant dengan sengaja; audit architect: tidak ada jalur baca tingkat outlet.
- **Ditahan:** ws/rat9r-followups (0260 `order_issue_paid_value`) dan ws/pti5r-promo-refund, kartu legend-bxdhv.
