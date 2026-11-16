# Desain legend-l2zru: "Bukan saya", bekukan batch, buka pembekuan

**Keputusan:** status beku disimpan di dua tabel append-only baru. `status='halted'`/`halt_reason` tidak dipakai, karena tiga alasan:
- `halted` hanya bisa dicapai dari `sending` (0344:239), jadi batch `exported` tidak bisa dibekukan lewat jalur itu.
- `legend_app` bisa menulis status batch, artinya bisa membuka pembekuan sendiri.
- `halt_reason` adalah enum untuk alasan provider, bukan sengketa.

Batch dianggap beku bila ada baris sengketa yang belum punya baris pembukaan.

## Migrasi `apps/api/drizzle/0660_payout_batch_disputes.sql` (+ meta, `db/schema/payroll-payout.ts`)

**Tabel `payroll_payout_batch_disputes`**
- Kolom: id, tenant_id, batch_id, log_id, grant_id, actor, session_id, reason varchar(500) null, batch_status_at varchar(16), created_at, txid.
- UNIQUE (tenant_id,id), (tenant_id,id,batch_id), (tenant_id,log_id), (tenant_id,grant_id).
- FK ditulis di dalam CREATE TABLE ke: tenants, batches (tenant_id,batch_id), approval_log (tenant_id,log_id), grants (tenant_id,id). Index (tenant_id,batch_id).

**Tabel `payroll_payout_batch_unfreezes`**
- Kolom: id, tenant_id, batch_id, dispute_id, grant_id, actor, session_id, role_template (CHECK owner/finance), reason varchar(500) NOT NULL (CHECK btrim minimal 10 karakter), created_at, txid.
- UNIQUE (tenant_id,dispute_id).
- FK inline: (tenant_id,dispute_id,batch_id) ke disputes, ditambah tenants, batches, grants.

**Hak dan penjaga untuk kedua tabel**
- Pemiliknya migrator. `legend_app` hanya SELECT, `legend_payout` SELECT dan INSERT.
- Trigger BEFORE UPDATE/DELETE per baris dan TRUNCATE per statement menolak dengan PAYOUT-80. RLS lewat `enforce_tenant_rls`.

**Kode error baru (79 sampai 82 belum terpakai)**
- 79: batch beku menolak langkah.
- 80: tabel sengketa tidak bisa diubah.
- 81: disown ditolak.
- 82: pembukaan ditolak.

**Grant**
- `kind_check` ditambah `disown` dan `unfreeze`.
- `payout_grant_issue` (badan 0658) mendapat dua pasangan baru:
  - `disown/record`: hanya method `password`. Memakai helper baru `app.payout_assert_session`: user tidak diblokir, sesi hidup, punya penugasan aktif apa pun di tenant. Tanpa syarat izin payroll dan tanpa syarat MFA 15 menit, supaya penyetuju yang izinnya dicabut penyerang tetap bisa membekukan. `p_ref` harus baris log di tenant ini dengan actor = p_actor dan batch = p_batch.
  - `unfreeze/approve`: `payout_assert_actor(...,'payroll.disburse.approve')` ditambah syarat penugasan aktif ber-scope `tenant` pada role dengan `template_key IN ('owner','finance')`.
- `detail` diisi sha256 alasan, jadi alasan terikat ke step-up.

**Fungsi tepercaya** (SECURITY DEFINER, milik `legend_payout`, EXECUTE untuk `legend_app`)
- `app.payout_approval_disown(p_log, p_grant, p_reason) → uuid`:
  1. Baca log. Grant dikonsumsi dengan batch dari log dan ref = log.
  2. Bila `grant.actor <> log.actor`, tolak dengan PAYOUT-81.
  3. Kunci batch dengan FOR UPDATE.
  4. INSERT dengan ON CONFLICT (tenant,log) DO NOTHING, lalu kembalikan id. Bila disown diulang, hasilnya id yang sama.
  5. Tetap boleh walau batch sudah final atau sudah beku.
- `app.payout_batch_unfreeze(p_batch, p_grant, p_reason) → int`:
  1. Konsumsi grant, kunci batch, cek ulang peran owner/finance.
  2. Penyetuju dikecualikan bila termasuk: requested_by, approved_by atau exported_by batch; confirmed_by, resolved_by atau resolved_by_2 item mana pun; atau actor log mana pun di batch itu. Satu pengecualian: pemohon adalah disputant semua sengketa yang masih terbuka (menarik klaimnya sendiri).
  3. Tidak ada sengketa terbuka: PAYOUT-82.
  4. Tulis satu baris pembukaan per sengketa terbuka. Satu orang cukup (founder Q12).

## Satu helper dan daftar penolakan

**Helper:** `app.payout_batch_assert_open(p_tenant, p_batch)`. Bila batch NULL langsung lolos. Mengambil kunci `FOR UPDATE` pada batch (serial dengan disown; bukan KEY SHARE, supaya langkah yang kemudian mengunci baris itu FOR UPDATE tidak menunggu dirinya sendiri), lalu menolak dengan PAYOUT-79 bila ada sengketa terbuka. EXECUTE untuk `legend_app` dan `legend_payout`.

**Dipanggil di:**
1. `payout_grant_consume` (0653), di semua kind kecuali disown/unfreeze. Ini menolak di awal.
2. `payout_attest` (0659), sebagai statement pertama. Ini menutup 17 fungsi:
   - correction_propose, correction_withdraw (0658)
   - correction_approve (0654)
   - overpaid_propose, overpaid_record, overpaid_withdraw (0658)
   - return_propose, return_confirm (0654)
   - proof_closure_propose, proof_closure_approve (0654)
   - posting_record_source (0654)
   - resolve_propose, resolve_approve, bank_confirm (0656)
3. `payout_run_settle` (0657), setelah batch dimuat.
4. Trigger baru (kena juga ke `legend_app`):
   - batches: BEFORE UPDATE bila status, approved_*, exported_*, content_hash atau source bank berubah. Ini menutup submit, approve, cancel, export dan penutupan batch.
   - items: BEFORE UPDATE OF status, settled_at, confirmed_*, resolved_*, resolution_* (cash handover dan export).
   - items: BEFORE INSERT, dicek pada batch percobaan sebelumnya dari payslip yang sama. Tanpa ini, payslip item yang `failed` palsu bisa dimasukkan ke batch baru dan dibayar dua kali.
   - `bank_transfer_files` BEFORE INSERT.
   - `payroll_payout_gl_postings` BEFORE INSERT.

**Sengaja tidak ditolak:** `payout_recon_flag` (justru membatasi), fungsi backfill/contest/bind bukti, dan disown/unfreeze sendiri.

**Sisi aplikasi:**
- `payroll-payout.service.ts`: `payoutGuardViolation` memetakan PAYOUT-79 ke 409 `PAYOUT_BATCH_FROZEN`. Tambah `assertBatchNotFrozen` sebelum grant diterbitkan.
- `payroll-payout-gl.service.ts` `listRecoveryBatchIds` melewati batch beku.
- Pengiriman Duitku belum ada, hanya `manual_bank` dan cash, dan keduanya sudah tertutup trigger di atas.

## API (di bawah `/api/hris/payroll`)

- `GET /payout-approval-log/:logId`: hanya untuk actor log itu (selain itu 404). Ini halaman tujuan link notifikasi tanda terima.
- `POST /payout-approval-log/:logId/disown` dengan body `{reason?}`:
  - Middleware: requireAuth, requireTrustedOrigin, requireTenantContext, stepUp, jsonBody, passwordStepUp. Tanpa izin payroll.
  - Service baru `payroll-payout-dispute.service.ts`.
- `POST /disbursement-batches/:id/unfreeze` dengan body `{reason 10..500}`:
  - Middleware: requireTenantPermission("payroll.disburse.approve"), lalu stepUp dan passwordStepUp.
- DTO batch ditambah `freeze {frozen, disputes[]}`.
- Validator dan DTO di `packages/shared/src/hris/payroll/payout-endpoints.ts`.

## Finance exception dan notifikasi

- Kind baru `payout_batch_disputed`, tingkat tenant dan berdiri selama sengketa masih terbuka. Detailnya `batch_status_at`.
- Batch yang sudah exported, sending atau completed menghasilkan baris yang harus dicek finance ke bank. Alasan pembukaan menjadi catatan hasil pemeriksaannya.
- Berkas: `packages/shared/src/validators/finance-exceptions.ts` dan `apps/api/src/services/accounting-finance-exceptions.service.ts`.
- `worker/payout-approval-receipt.job.ts` ikut menyapu tabel sengketa dan pembukaan. Event `payout.batch_disputed {disputeId}` dan `payout.batch_unfrozen {unfreezeId}`, id event diturunkan dari id baris.
- Rule di `notification-adapters.ts`: penerimanya pemegang template owner/finance ber-scope tenant (pola baris 870-887) ditambah disputant. Kategori `payout_receipt` (wajib email, menembus jam tenang). Teks tanpa nominal.
- Berkas lain: `packages/shared/src/hris/payroll/events.ts` dan `events/catalog.ts`.

## Teks UI (text-contract)

- `packages/shared/src/i18n/messages/ws10-payroll-payout-receipt.ts`: layar disown dan teks notifikasi.
- `ws10-payroll-payout.ts`: banner beku, dialog buka pembekuan, error PAYOUT_BATCH_FROZEN.
- `ws07-finance-exceptions.ts`: label kind baru.
- Penegaknya `tests/text-contract.test.mjs`.

## Risiko

- **Penyerang membekukan batch sendiri:** hanya menunda pembayaran, tidak membuat siapa pun dibayar lebih, dan owner/finance diberi tahu.
- **Disown oleh orang lain, bukan actor log:** ditolak dua kali, di penerbitan grant dan di fungsi disown. `legend_app` tidak punya hak INSERT ke tabel sengketa.
- **Penyetuju palsu (sesi B dicuri):** B menerima notifikasi dan membekukan. Langkah yang sudah terjadi sebelum disown tidak dibatalkan otomatis; finance exception yang menampungnya.
- **Pelaku membuka pembekuannya sendiri:** dicegah aturan pengecualian di atas.
- **Tidak ada orang yang memenuhi syarat untuk membuka:** batch tetap beku (aman), owner harus menambah peran. Ini perlu dibawa ke founder.
- **Sisa risiko lama:** `legend_app` masih bisa menulis `session` dan `role_assignments`. Persetujuan utama (`approvedBy`) tidak lewat grant sehingga tidak bisa di-disown; perlu bead lanjutan.

## Test (`apps/api/src/test/payroll-payout-918-disown.test.ts`)

1. Disown oleh actor log menghasilkan batch beku. Tiap fungsi dari 17 fungsi grant dan `run_settle` ditolak PAYOUT-79 (test berparameter), dan grant-nya tidak ikut terpakai.
2. Disown oleh user lain: 404/PAYOUT-81, dan penerbitan grant juga menolak.
3. Actor yang izinnya dicabut tetap bisa disown; user diblokir ditolak; tanpa step-up password: 401.
4. Disown diulang mengembalikan id sama. Dua log di satu batch menghasilkan dua sengketa, dan satu pembukaan melepas keduanya.
5. Submit, approve, cancel, export dan confirm-cash: 409. SQL langsung sebagai `legend_app` (UPDATE status, insert file bank, insert posting GL, batch baru dengan payslip dari batch beku): PAYOUT-79.
6. `recon_flag` tetap jalan saat beku.
7. Pembukaan:
   - Diterima: owner atau finance di luar batch, dan disputant yang menarik klaimnya.
   - Ditolak: hr, owner ber-scope brand, requester, approver, actor log.
   - Validasi: alasan kurang dari 10 karakter 422, tidak ada sengketa terbuka 409.
   - Setelah dibuka, semua langkah jalan lagi.
8. Append-only: `legend_app` mendapat 42501 untuk INSERT/UPDATE/DELETE/TRUNCATE; `legend_payout` mendapat PAYOUT-80 untuk UPDATE/DELETE/TRUNCATE; RLS antar tenant.
9. Batch exported yang di-disown muncul sebagai finance exception dan hilang setelah dibuka.
10. Disown dan bank_confirm berbarengan: urutannya serial di kunci batch.
11. Notifikasi: idempoten, penerima benar, tanpa angka Rp, email tetap terkirim walau preferensi dimatikan.
12. Alasan diubah di tengah jalan (sha `detail` tidak cocok): PAYOUT-70.
13. Invarian uang: setelah beku, jumlah item `succeeded` dan jurnal tidak berubah.

**Urutan kerja:**
1. Migrasi 0660.
2. Schema dan shared contract.
3. Service, rute, dan pemetaan error.
4. Worker dan finance exception.
5. Web dan katalog teks.
6. Test, lalu review architect xhigh.
