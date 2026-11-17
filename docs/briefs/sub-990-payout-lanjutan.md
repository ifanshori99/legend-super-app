# Brief subagent 990: payout lanjutan (recon flag, jurnal fee, bukti return)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-92055877` (cabang dari origin/milestone/m1 1b0fd2a9e).
Konteks: payout 905/911/954 sudah di m1. Laporan 905/911 di `docs/PROGRESS.md`, antrean di `docs/merge-queue.md`.
Migrasi m1 sudah di-renumber (laporan menyebut 0647/0649; cari padanannya di `apps/api/drizzle/` lewat grep nama fungsi). Migrasi baru cabang ini: 0580-0584 (nomor kerja).
Layanan inti: `apps/api/src/services/payroll-payout-*.ts`, terutama `payroll-payout-recon.service.ts`, `payroll-payout-overpaid*.ts`, `payroll-payout-gl.service.ts`, `payroll-payout-proof-closure.service.ts`, `payroll-payout-grant.service.ts`, `payroll-payout-evidence*.ts`. Test: `apps/api/src/test/payroll-payout-9xx-*.test.ts`.

Jangan sentuh: refund/recon provider (980, 967), charge tukar menu (982/985), DOIT (965), payroll (983), akses perangkat (984), fasilitas (987), approval kas keluar supplier (991).

## Kartu

A. legend-xbagc: `payroll_payout_recon_exceptions` insert-only; flag menahan slip dari batch baru tanpa jalan keluar. Butuh fungsi tepercaya `legend_payout` (propose/approve dua orang finance, step-up) untuk menandai flag selesai + audit. Pembuat tidak boleh menyetujui sendiri.
B. legend-d9pxr: posting overpaid fee_idr>0 tanpa jurnal `payroll-payout-overpaid-fee:<id>` lolos (cek commit di `payout_item_money_commit_check` hanya jurnal utama; recon juga tidak cek). Tambah cek fee di commit check + recon.
C. legend-y2lk2: `PayoutReconKind` tidak punya closure; closure palsu (pemalsu user/sesi/role) membuka gerbang key dan approve membekukan hash lintas tenant tanpa dicek recon. Tambah pemeriksaan attestation closure di recon.
D. legend-r8nas: recon memuat attestation hanya untuk batch yang punya correction/overpaid/return/posting-source; resolve & bank_confirm sendiri serta closure tidak dicek; `evaluateGrants` belum membandingkan item_set_hash, detail, ref_id.
E. legend-nsqhm: bukti return payout wajib nomor referensi transaksi bank (identitas dana kembali) selain fingerprint berkas. Lanjutan F2 audit 872 (`docs/qa/second-opinion-payout-870.md`).
F. (opsional) legend-wrz3v: tampilkan ke finance posting bank yang menunggu mapping biaya (`skipped_settle_no_fee_mapping`).

## Wajib dibuktikan test (jangan sampai rugi)
1. Flag recon tidak bisa ditutup satu orang (pembuat = penyetuju ditolak; tanpa step-up ditolak).
2. Fee/jurnal seimbang; tidak ada payout dobel atau lebih bayar, termasuk bersamaan.
3. Return tanpa referensi bank ditolak (API dan DB).
4. Tenant/outlet lain tidak tersentuh.

## Aturan test
- Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Jangan `pnpm test` penuh / `pnpm check`.
- Satu token heavy per thread: hanya satu subagent menjalankan vitest/tsc pada satu waktu.
- ID ULID bila API meminta ULID; tipe brand pakai helper proyek, bukan `as`.
- Tabel/migrasi baru wajib diakui di `apps/api/src/test/data-import-registry.test.ts` dan tes cakupan tabel schema; FK tabel baru inline di CREATE TABLE.

## Keputusan desain (engineer, mengikat)

Migrasi sudah dibuat dan di-commit (journal + snapshot): `apps/api/drizzle/0580_payout_990_schema.sql` (generated: tabel `payroll_payout_recon_clearances`, grant kind `recon_clear`, kolom `payroll_disbursement_items.return_bank_ref`, `payroll_payout_return_claims.bank_ref` + unique index parsial per tenant), lalu file custom kosong `0581_payout_990_recon_clear.sql` (A), `0582_payout_990_fee_commit.sql` (B), `0583_payout_990_return_bank_ref.sql` (E). Schema TS sudah diubah (`apps/api/src/db/schema/payroll-payout.ts`). JANGAN ubah schema TS, journal, atau snapshot; JANGAN jalankan db:generate. Butuh perubahan schema: lapor ke engineer.
Kode error baru: PAYOUT-85 dst. A memakai 85-87, E memakai 88-89, B memakai 90. Pola fungsi tepercaya: `app.payout_batch_unfreeze` (0433:889) + `app.payout_grant_issue` (0433:703) + `app.payout_grant_consume` (0436:92); pemanggil TS: `payroll-payout-dispute.service.ts` + `payroll-payout-grant.service.ts`. Selalu salin definisi TERBARU fungsi (grep semua migrasi, ambil nomor tertinggi) sebelum CREATE OR REPLACE.
Larangan: jangan jalankan vitest/tsc/pnpm test (satu token heavy dipegang test-writer lalu test-runner). Boleh `pnpm exec eslint <file>` dan `pnpm exec prettier --write <file>` pada file sendiri.

### I1: A-db (file: 0580 dan 0581 saja)
- 0580: pindahkan semua `ALTER TABLE "payroll_payout_recon_clearances" ADD CONSTRAINT ... FOREIGN KEY` ke dalam CREATE TABLE; tambah `SELECT app.enforce_tenant_rls(...)` untuk tabel baru; hak akses meniru `payroll_payout_proof_closures` di 0410 (legend_app hanya SELECT; INSERT + UPDATE kolom approved_* hanya lewat fungsi tepercaya/legend_payout); trigger guard: DELETE ditolak, UPDATE hanya mengisi approved_* sekali dari NULL, kolom lain tetap.
- 0581: (1) CREATE OR REPLACE `app.payout_grant_issue` dari versi terbaru + kind `recon_clear` step `propose`/`approve`: password saja, peran owner/finance tingkat tenant (seperti unfreeze) + `payout_assert_actor(...,'payroll.disburse.approve')`, `p_ref` = id flag (propose) atau id clearance (approve) yang ada di tenant, `p_detail` = sha256 hex alasan (propose: alasan yang diajukan; approve: alasan tersimpan), `p_batch` = batch dari item flag; approve: aktor = pengusul ditolak saat issue (PAYOUT-86). Cek apakah `payout_grant_consume` perlu diubah (daftar kind/step) dan ubah bila perlu.
  (2) `app.payout_recon_clear_propose(p_exception uuid, p_grant text, p_reason text) RETURNS uuid` dan `app.payout_recon_clear_approve(p_clearance uuid, p_grant text) RETURNS uuid`, SECURITY DEFINER, owner/hak EXECUTE sama seperti fungsi payout tepercaya lain. Alasan 10-500 karakter (PAYOUT-85). Approve: kunci baris FOR UPDATE, sudah disetujui ditolak (PAYOUT-87), penyetuju = pengusul ditolak (PAYOUT-86), sesi pengusul juga tidak boleh menyetujui. Flag tenant lain: tidak ditemukan (RLS + tenant filter).
  (3) Helper `app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid) RETURNS boolean` = ada flag untuk payslip itu yang TIDAK punya clearance disetujui. CREATE OR REPLACE semua fungsi aktif yang menaikkan PAYOUT-62 karena recon_exceptions (setidaknya 0433:~290 dan 0422:~650; cek versi terbaru tiap nama fungsi) supaya memakai helper. Cek overpaid (PAYOUT-62 kedua) tetap.
  (4) `payout_recon_flag` tetap ON CONFLICT DO NOTHING: flag yang sudah di-clear untuk kunci yang sama tidak muncul lagi (catat di komentar).
  Tulis ringkasan signature final di `docs/briefs/990/i1-contract.md` begitu signature tetap (I2 membacanya).

### I2: A-api (file baru saja + registrasi)
- `apps/api/src/services/payroll-payout-recon-clearance.service.ts`, `apps/api/src/routes/payroll-payout-recon-clearance.routes.ts` (daftar di `routes/index.ts`), validator `packages/shared/src/validators/payroll-payout-recon-clearance.ts` (+ subpath di `packages/shared/package.json` exports bila perlu), DTO di `packages/shared/src/types/api.ts`.
- Endpoint (tenant, permission `payroll.disburse.approve`, guard seperti rute unfreeze di `payroll-payout-dispute` routes): `GET /api/payroll/payout/recon-flags` (flag + status clearance), `POST /api/payroll/payout/recon-flags/:flagId/clearance` body `{reason, password}` → 201 `{clearanceId}`, `POST /api/payroll/payout/recon-clearances/:clearanceId/approve` body `{password}` → 200. Grant lewat `payroll-payout-grant.service.ts` (kind `recon_clear`). Peta error: PAYOUT-85 → 422, 86 → 403, 87 → 409; password salah → seperti unfreeze. Sesuaikan path dengan konvensi rute payout yang ada bila berbeda dan tulis path final ke `docs/briefs/990/i2-contract.md`.
- Signature SQL dari `docs/briefs/990/i1-contract.md` (tunggu berkas itu bila belum ada; sementara pakai signature di I1).
- Izin/label/teks baru wajib masuk katalog (lihat aturan katalog di brief root `tests/*-contract.test.mjs`).

### I3: B-db (file: 0582 saja)
- CREATE OR REPLACE `app.payout_item_money_commit_check()` dari 0415:79 (cek tidak ada versi lebih baru). Cabang overpaid: bila posting overpaid fee_idr > 0, wajib jurnal `payroll-payout-overpaid-fee:<id>` ada dan seimbang (pakai `app.payout_item_journal_ok` atau padanannya), dengan syarat yang SAMA PERSIS dengan kapan service membukukannya (`payroll-payout-overpaid.service.ts:256-258` locked || feeOnly, `:340-355`). Jangan menolak alur sah. PAYOUT-90 untuk pesan baru bila perlu. Tulis catatan syarat ke `docs/briefs/990/i3-note.md` (I4 memakainya untuk recon).

### I4: recon (file: `apps/api/src/services/payroll-payout-recon.service.ts` saja)
- B: tambah `overpaidFeeJournalKey(id)` ke journalKeys (:751) dan evaluasi `journal_missing`/`journal_reversed` untuk jurnal fee bila fee > 0 dengan syarat sama seperti service (lihat I3).
- C: closure: muat `payroll_payout_proof_closures` sejak `app.payout_trusted_since()`; untuk tiap closure cek attestation kind `closure` step propose dan approve ada, aktor/sesi cocok dengan proposed_by/closed_by, closed_by ≠ proposed_by, grant terpakai cocok (evidence_key). Flag kind `closure` (recon_exceptions.item_id NOT NULL: flag tiap item yang memakai evidence key itu; tulis keputusan di komentar). Tambah `closure` ke `PayoutReconKind` bila perlu.
- D: muat attestation untuk batch yang punya attestation resolve/bank_confirm/closure walau tanpa operasi lain; `evaluateGrants` juga membandingkan item_set_hash (grant vs `itemSetHashOf(attestation.item_ids)`), detail (resolve: outcome; bank_confirm: 'succeeded'), ref_id bila attestation punya padanan. Jangan select `secret_sha256`/`assertion`.
- Recon tidak boleh menandai alur sah (test 905-recon/911-grants yang ada tetap hijau).

### I5: E-api (file: 0583, `packages/shared/src/validators/payroll-payout.ts` bagian return, `payroll-payout-manual.service.ts` bagian return, `payroll-payout-return.routes.ts`)
- Validator `returnManualItemsSchema`: field wajib `bankRef` (trim, 4-64 karakter, pola seperti `bankRef` confirm di :176).
- Normalisasi: trim, huruf besar, hapus spasi dalam. Service meneruskan ke fungsi SQL return tepercaya (cari versi terbaru fungsi return propose/confirm, mis. 0351/0367/0414/0420/0425) → CREATE OR REPLACE di 0583 dengan parameter `p_bank_ref`: kosong/NULL ditolak (PAYOUT-88), simpan ke `payroll_payout_return_claims.bank_ref` dan `payroll_disbursement_items.return_bank_ref`; langkah kedua (confirm) wajib bank ref sama dengan klaim (PAYOUT-89); unique index per tenant → bank ref yang sama tidak boleh dipakai klaim lain (pesan jelas, 409). Tenant lain boleh memakai ref yang sama. Bila signature fungsi berubah, DROP versi lama supaya legend_app tidak bisa memanggil jalur tanpa ref.
- Tulis field/route final ke `docs/briefs/990/i5-contract.md` (I6 memakainya).

### I6: E-web (file: `apps/web/src/features/ws10-payroll-payout/components/status-dialogs.tsx` bagian `ReturnDialog`, `api.ts`, `mock.ts`, `packages/shared/src/i18n/messages/ws10-payroll-payout-review.ts`)
- Field wajib "Nomor referensi transaksi bank" di ReturnDialog, meniru field bankRef di dialog confirm (:545-663), dikirim sebagai `bankRef`. Teks lewat katalog i18n. Mock ikut. Jangan sentuh file lain.

## Fase 2 (setelah I1-I6)

### I2b: rekonsiliasi A (file: `payroll-payout-recon-clearance.service.ts`, routes-nya, validator clearance, `apps/api/src/test/data-import-registry.test.ts`, tes cakupan tabel schema payout)
- Samakan service dengan `docs/briefs/990/i1-contract.md` (propose idempoten: flag dengan clearance terbuka mengembalikan id yang sama, jangan 409; approve: detail grant = sha256 alasan TERSIMPAN; p_batch = batch item flag; peta PAYOUT-69/72/70/42). Akui tabel `payroll_payout_recon_clearances` + migrasi 0580-0583 di registry dan tes cakupan tabel (cari "covers exactly the tables exported by db/schema/payroll-payout.ts" atau padanannya; grep `0442` di test).

### I5b: peta error return (file: pemeta error payout API yang menghasilkan `PAYOUT_GUARD_REFUSED`, `apps/web/src/features/ws10-payroll-payout/errors.ts`, katalog i18n web bila perlu)
- PAYOUT-88 → 422 `PAYOUT_RETURN_BANK_REF_INVALID`, PAYOUT-89 → 409 `PAYOUT_RETURN_BANK_REF_MISMATCH`, unique bank ref → 409 `PAYOUT_RETURN_BANK_REF_REUSED` (cek nama yang dipakai I5 di `docs/briefs/990/i5-contract.md` dan mock I6). Web: pesan jelas untuk ketiganya + PAYOUT-85/86/87 bila ada pemeta web yang dipakai. Teks lewat katalog.

### T1-T3: test lama pemanggil return (hanya file test yang disebut di prompt)
- Return sekarang wajib `bankRef` (API) dan `p_bank_ref` (SQL `app.payout_return_propose`/`payout_return_confirm`, lihat `docs/briefs/990/i5-contract.md`). Tambahkan ref unik per klaim (mis. `"TRX" + randomUUID().slice(0,8)`), langkah kedua memakai ref yang sama. Jangan ubah ekspektasi lain. Jangan jalankan vitest.
