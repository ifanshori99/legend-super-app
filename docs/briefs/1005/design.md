# 1005 (legend-snwnn): tarik klaim return payout, dua orang

Base 74e142d8b (990). Tingkat K. Migrasi: 0615 (schema+fungsi withdraw), 0616 (flag kind recon). Kode error baru PAYOUT-92..96 (grant service membaca `^PAYOUT-(\d\d):`, jadi 2 digit).

## Keputusan desain
- Withdraw hanya untuk klaim `open` (belum dikonfirmasi). Klaim `consumed` (item `returned`, jurnal terposting) TIDAK bisa ditarik: terminal. Jurnal tidak pernah diubah/dihapus.
- Dua langkah, pola `recon_clear` (0581): grant kind baru `return_withdraw` (15 char, muat varchar(16)), step `propose` dan `approve`, password step-up saja (bukan MFA saja), pemegang peran tenant-wide owner/finance + `payroll.disburse.approve`. Detail grant = sha256 hex alasan. Ref grant = klaim (propose) atau withdrawal (approve); batch = batch klaim.
- Approve: pengusul DAN sesi pengusul tidak boleh (PAYOUT-94, dicek di `payout_grant_issue` dan lagi di fungsi approve). Requester batch tidak boleh propose/approve (PAYOUT-64, seperti return).
- Approve: klaim harus masih `open` dan item masih `succeeded` dengan `return_claim_id = klaim`, `returned_by = created_by`, `returned_by_2 IS NULL`, tak ada jurnal `return` terposting untuk item itu; selain itu PAYOUT-93 (tidak ada perubahan apa pun).
- Efek approve (satu transaksi, role legend_payout): klaim `open -> withdrawn` (+`withdrawn_at`); kolom item `returned_by, return_evidence_key, return_note, return_claim_id, return_bank_ref` dikosongkan; status item tetap `succeeded` (= status sebelum klaim). Baris klaim dan baris withdrawal tetap (audit).
- Bukti (proof) klaim yang ditarik TETAP terbakar: `evidence_files`, `proof_bindings`, `proof_hashes`, dan unique evidence_key/content_sha/stored_sha di tabel klaim tidak diubah (tabel append-only). Ajukan ulang butuh berkas bukti BARU. Hanya unique `payroll_payout_return_claims_bank_ref_key` dijadikan parsial `AND status <> 'withdrawn'` (klaim yang ditarik tidak pernah memindahkan uang), supaya ref benar bisa dipakai lagi.
- Tidak ada pembayaran ulang otomatis: withdraw tidak menyentuh item selain kolom return di atas, tidak menyentuh batch/status bayar/jurnal. Konfirmasi klaim `withdrawn` ditolak (PAYOUT-63 "already consumed" diganti pesan: klaim bukan open).
- Konfirmasi (`payout_return_confirm`) tidak diblokir oleh withdrawal yang menunggu; siapa duluan menang (klaim berubah -> approve withdraw PAYOUT-93).
- Withdrawal yang sudah disetujui tidak bisa disetujui lagi (PAYOUT-95). Propose kedua pada klaim yang sama saat ada usulan terbuka: idempoten (kembalikan usulan, alasan pertama tetap), seperti clearance.

## Kode error
- PAYOUT-92 (23514) alasan withdraw bukan 10-500 karakter.
- PAYOUT-93 (23514) klaim tidak bisa ditarik (bukan open, item berubah, jurnal ada).
- PAYOUT-94 (42501) pengusul (user atau sesi) tidak boleh menyetujui.
- PAYOUT-95 (23514) withdrawal sudah disetujui/tidak bisa berubah.
- PAYOUT-96 (23514) withdrawal/klaim tenant lain atau tidak ada -> pakai PAYOUT-69 (P0002) seperti clearance; 96 dicadangkan.

## Tabel baru `payroll_payout_return_withdrawals`
id uuid pk, tenant_id, claim_id (FK (tenant_id, claim_id) -> return_claims), batch_id, reason text (10-500), reason_sha256, proposed_by, proposed_session_id, proposed_at, approved_by null, approved_session_id null, approved_at null, flag. Unique (tenant_id, id); satu usulan terbuka per klaim (partial unique claim_id WHERE approved_at IS NULL); satu approved per klaim. Insert oleh payout role; update hanya mengisi approved_* sekali (guard trigger). FORCE RLS seperti tabel payout lain (lihat `migration-force-rls-guard.test.ts`, `migration-fk-force-rls.test.ts`). FK tabel baru ditulis inline di CREATE TABLE.

## Fungsi SQL (SECURITY DEFINER, owner legend_payout, EXECUTE legend_app saja)
- `app.payout_return_withdraw_propose(p_claim uuid, p_grant text, p_reason text) RETURNS uuid`
- `app.payout_return_withdraw_approve(p_withdrawal uuid, p_grant text) RETURNS integer` (jumlah item dipulihkan)
- `app.payout_grant_issue`: tambah kind `return_withdraw` (propose/approve), cek seperti `recon_clear` (password, owner/finance, ref/batch, PAYOUT-94). Salin body 0581 terbaru, jangan buang cabang lain.
- Attestasi: `app.payout_attest(... kind 'return_withdraw', operation = withdrawal id, step propose|approve, evidence_key = bukti klaim, binding = binding bukti klaim ...)`. Tambah `return_withdraw` ke CHECK kind di attestations, exceptions, grants (+ `PAYOUT_ATTESTATION_KINDS`, `PAYOUT_GRANT_KINDS` di schema TS), dan step `approve` sudah ada di `PAYOUT_ATTESTATION_STEPS` (cek).
- Guard klaim 0389: izinkan `open -> withdrawn` (hanya legend_payout), CHECK status + consumed_check diperluas (`withdrawn` butuh `withdrawn_at`, kolom baru nullable).
- Guard item (`payroll_disbursement_items_guard`, versi terbaru): izinkan pengosongan kolom return di atas hanya sebagai legend_payout saat klaim terkait `withdrawn` dan status item tetap `succeeded`. Cek apakah 0583/0584 mendefinisikan ulang guard ini sebelum menyalin.
- 0616: ganti `app.payout_recon_flag` (0584:172) agar daftar kind memuat `return_withdraw`; periksa fingerprint 0584 masih cocok.

## Recon (src/services/payroll-payout-recon.service.ts)
- `listOperations`: tambah operasi kind `return_withdraw` dari tabel withdrawals (butuh attestasi propose + approve, dua orang dan dua sesi berbeda, grant ada). Withdrawal approved tanpa attestasi sah, atau klaim `withdrawn` tanpa withdrawal approved, atau item yang return-kolomnya kosong tanpa klaim withdrawn: flag baru (alasan memakai set alasan yang ada; tambah bila perlu). Klaim `withdrawn` tidak lagi dihitung operasi `return` terbuka.
- Pastikan klaim `open` yang ditarik tidak menghasilkan flag palsu pada recon return biasa.

## API (src/routes/payroll-payout-return-withdraw.routes.ts, mount di routes/index.ts di bawah `/hris/payroll`, bentuk seperti payroll-payout-recon-clearance.routes.ts)
- `GET /disbursement-batches/:id/return-claims` daftar klaim batch (id, status, bank_ref, jumlah item, created_by, withdrawal terbuka) bila belum ada jalur baca klaim.
- `POST /payout-return-claims/:claimId/withdrawal` body `{reason}` (propose).
- `POST /payout-return-withdrawals/:withdrawalId/approve` (approve).
- Rantai guard POST identik clearance: requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission("payroll.disburse.approve"), stepUp MFA, jsonBody, passwordStepUp.
- Validator zod di `packages/shared/src/validators/payroll-payout-return-withdraw.ts` + subpath exports; DTO di `types/api.ts`.
- Service `src/services/payroll-payout-return-withdraw.service.ts` (grant via `payoutTrustedGrant`, detail sha256 alasan, map error PAYOUT-92..95 seperti `clearanceError`).

## Test (src/test/payroll-payout-1005-return-withdraw.test.ts + ...-1005-return-withdraw-recon.test.ts), gagal-dulu di base
1. Dua orang withdraw -> klaim withdrawn, item `succeeded` dan kolom return kosong; jurnal (gl postings) dan baris attestasi lama tak berubah (hitung sebelum/sesudah).
2. Satu orang sendirian: pengusul approve ditolak (user sama; sesi sama dengan user lain di sesi yang sama; PAYOUT-94); tanpa password step-up ditolak; kata sandi dicek di tiap langkah.
3. Klaim `consumed` tidak bisa ditarik (PAYOUT-93); item `returned` tidak bisa dikonfirmasi dua kali; klaim withdrawn tidak bisa dikonfirmasi.
4. Setelah withdraw: ajukan ulang dengan ref baru + bukti baru -> klaim open baru; ref lama yang sama + bukti baru boleh; bukti lama tertolak (PAYOUT-65/hash). Konfirmasi baru -> item returned satu kali, satu jurnal.
5. Tidak ada pembayaran ulang otomatis: setelah withdraw tak ada item/batch baru, status item tetap succeeded, tak ada jurnal baru.
6. Recon: withdrawal approved yang attestasinya dihapus/palsu (insert langsung sebagai superuser di test) diflag; klaim withdrawn tanpa withdrawal diflag; kasus bersih tidak diflag.
7. Tenant lain: withdraw/approve klaim tenant lain -> PAYOUT-69/404; data tenant lain tak berubah.
8. Requester batch tak boleh propose/approve; alasan 9 atau 501 karakter ditolak (PAYOUT-92).

Pakai helper dari `payroll-payout-990-return-bank-ref.test.ts` dan `payroll-payout-990-recon-clear.test.ts` (makePerson, proposeHttp, approveHttp, flaggedWorld, dst).
