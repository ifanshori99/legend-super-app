# 905 desain (architect xhigh, 16 Nov) + amandemen engineer

Semua path relatif `apps/api/` kecuali `packages/`. Konteks: `brief.md` di folder ini.

## Peran (0644)
- `legend_payout`: NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT. RLS tetap berlaku (policy tenant mencakup semua role).
- Kepemilikan dalam migrasi: (1) `GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE` (2) `GRANT CREATE ON SCHEMA app TO legend_payout` (3) `ALTER FUNCTION … OWNER TO legend_payout` (4) `REVOKE CREATE ON SCHEMA app FROM legend_payout` (5) `REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER` (wajib: `assertManagesOnly` menolak migrator yang tetap punya SET). Migrasi berikut yang membuat fungsi milik legend_payout mengulang pola grant→alter owner→revoke.
- Tambah `legend_payout` ke daftar role `grantAdminOnExistingRoles` di `src/db/migrator-role.ts`.
- Tabel baru di 0644 (FK inline, RLS on, `legend_app` SELECT saja):
  - `payroll_payout_attestations`: tenant, kind, operation_id, step, batch, item_ids, evidence_key, binding_id, actor, session_id, session_created_at, mfa_verified_at, attested_at, txid. Unique (tenant, kind, operation, step). Insert-only.
  - `payroll_payout_recon_exceptions` (insert-only; menahan retry slip).
  - `payroll_payout_proof_closures` (kartu 3).
- Grant ke `legend_payout`: SELECT tabel yang dibaca; INSERT/UPDATE corrections, overpaid proposals, return claims, attestations, closures, exceptions; INSERT bindings, hash contests; UPDATE item kolom status, confirmed_*, settled_at, updated_at, gl_posting_id, returned_*, return_*; UPDATE posting `source_gl_account_id`.
- RISIKO 1: bila non-superuser migrator tidak bisa memindah kepemilikan di PG17, fallback pola 0274 (migrator pemilik). Lapor dulu sebelum fallback.

## Fungsi tepercaya
Semua `SECURITY DEFINER SET search_path = pg_catalog, pg_temp`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO legend_app` (kecuali helper internal). Hash bukti dibaca dari record evidence tersimpan, bukan argumen.
- Helper internal (owner-only): `app.payout_assert_actor(tenant uuid, actor text, session text, perm text) RETURNS jsonb`: user ada; session milik user, hidup, `mfa_verified_at` ≤15 menit dan tidak di masa depan; user punya `role_assignments` tenant-scope aktif yang `roles.permissions ? perm`. Snapshot disimpan di attestation.
- 0645 kartu 1:
  - `app.payout_bind_proof(batch uuid, kind text, item_ids uuid[], key varchar, actor text) RETURNS uuid`
  - `app.payout_backfill_bind(batch, kind, item_ids, key, legacy_duplicate boolean) RETURNS uuid` (operasi harus ada di `app.payout_proof_operations()`)
  - `app.payout_backfill_claim_hashes(claim uuid) RETURNS boolean`
  - `app.payout_correction_propose(batch, item_ids, key, note, actor, session) RETURNS uuid`; `app.payout_correction_approve(operation uuid, key, actor, session) RETURNS int`
  - `app.payout_overpaid_propose(batch, item_ids, key, note, actor, session) RETURNS uuid`; `app.payout_overpaid_record(item uuid, key, posting uuid, actor, session) RETURNS void`
  - `app.payout_return_propose(batch, item_ids, key, note, actor, session) RETURNS uuid` (claim); `app.payout_return_confirm(claim uuid, key, actor, session) RETURNS int`
  - `app.payout_proof_contest_own(varchar) RETURNS boolean`: DROP + re-create; hanya mengonteskan bila baris tenant sendiri menunjukkan >1 operasi atas key atau binding legacy_duplicate. Efek hanya dari data tersimpan → setel `app.tenant_id` ke PT lain tidak bisa memblokirnya.
  - Tiap fungsi langkah memeriksa ulang di SQL: status item; dua orang (aktor ≠ pengusul, ≠ requester batch, ≠ resolver kegagalan); binding kind/batch/item set sama; gerbang global, contest, closure. Tulis satu attestation per langkah.
- Guard item (0645, rewrite): `current_user = 'legend_payout'` wajib untuk failed→succeeded, failed→overpaid, succeeded→returned, dan perubahan kolom `returned_*`/`return_*`.
  - **Amandemen engineer A1:** juga wajib legend_payout untuk SEMUA perubahan status keluar dari `succeeded`/`overpaid`/`returned` (mis. succeeded→failed membuka retry = bayar dua kali). Jalur aplikasi yang sah untuk itu harus lewat fungsi; bila ada jalur sah lain (grep), lapor.
  - Cabang insert menolak attempt baru untuk slip yang punya recon exception terbuka.
  - Constraint trigger baru `app.payout_item_money_commit_check` AFTER UPDATE OF status DEFERRABLE INITIALLY DEFERRED: saat COMMIT wajib posting tertaut kind benar; settle → `payout_settle_journal_ok`; return/overpaid → jurnal seimbang debit>0 di key item; dua attestation aktor beda.
- REVOKE dari `legend_app` (0645): corrections, overpaid_proposals, return_claims: INSERT, UPDATE. proof_bindings: INSERT. items: revoke UPDATE tabel, lalu GRANT UPDATE semua kolom kecuali `returned_by, returned_by_2, return_evidence_key, return_note, return_claim_id, returned_at`. Status/confirmed_* tetap di-grant untuk alur normal; guard menjaganya (amandemen A1). Hapus pemakaian GUC `app.payout_correction`/`app.payout_overpaid` sebagai otorisasi.

## 0646 kartu 2(b)
- `app.payout_posting_record_source(batch, posting, gl_account uuid, actor, session) RETURNS void`: posting pending/skipped tanpa sumber; batch cash atau bank tanpa rekening beku; aktor ≠ requester; akun milik legal entity batch dan bisa diposting: cash-and-equivalents untuk cash, `bank_accounts` aktif untuk bank.
- Cabang ELSE fill di guard posting (0642 → CREATE OR REPLACE) tambah `AND current_user = 'legend_payout'`. Cabang bank beku tetap terbuka bagi legend_app.
- Service: `src/services/payroll-payout-source.service.ts` (`recordPostingSource`) memanggil fungsi.
- 0643 (sudah ada): AFTER INSERT deferred check, jangan diubah.

## 0647 kartu 3
- `app.payout_proof_closure_propose(key varchar, note, actor, session) RETURNS uuid`: key wajib punya baris stuck belum resolved.
- `app.payout_proof_closure_approve(closure uuid, actor, session) RETURNS boolean`: approver ≠ pengusul, ≠ requester; idempoten (sudah closed → hasil sama); kontes semua hash yang diketahui secara global; set `resolved_at` baris stuck.
- `app.payout_proof_tenant_pending()`: keempat kondisi mengabaikan key yang ditutup.
- Backstop: key tertutup ditolak di bindings, claims, dan kolom `*_evidence_key` item.
- Penutupan tidak mengubah item. Proposal terbuka atas key itu tidak bisa selesai. Slip dengan proposal koreksi/overpaid terbuka atas key tertutup ditahan dari retry.

## Yang tidak bisa dibuktikan SQL (legend_app bisa tulis barisnya)
Identitas manusia (user/session/account/role_assignments/roles/audit_logs bisa ditulis; step-up password tidak meninggalkan catatan), byte bukti (hash dari app), transfer bank, nominal item (terenkripsi). Ditutup secara detektif oleh recon malam.

## Recon malam (C4)
`src/worker/payout-trusted-recon.job.ts`, `src/services/payroll-payout-recon.service.ts`. Untuk tiap item corrected/overpaid/returned dan tiap posting source yang dicatat: dua attestation dari sesi beda; sesi cocok snapshot, MFA segar; dua audit row cocok; tepat satu binding, tidak dikonteskan; jurnal ada dan tidak di-reverse; net item terdekripsi = debit jurnal; file bukti dibaca ulang dan di-hash cocok record. Selisih → `app.payout_recon_flag(tenant, kind, operation, item, reason)` (fungsi legend_payout, insert-only) dan juga muncul sebagai finance exception (`accounting-finance-exceptions.service.ts`). Daftarkan job seperti `payout-gl-recovery`.

## Endpoint kartu 3 (C3)
Router baru `src/routes/payroll-payout-proof-closure.routes.ts`, mount `/api/hris/payroll`, daftar di `src/routes/index.ts`. Service `src/services/payroll-payout-proof-closure.service.ts`.
- `GET /payout-proofs/stuck?cursor&limit` izin `payroll.disburse.approve` → `PayoutStuckProof[]` {evidenceKey, batchId, reason, attempts, firstSeenAt, closure|null}.
- `POST /payout-proofs/closures` {evidenceKey, note, password?} → {closureId, stage:"proposed"}.
- `POST /payout-proofs/closures/:id/approve` {password?} → {closureId, stage:"closed", gatePending}.
- POST: requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission, stepUp, jsonBody, passwordStepUp (tiru `routes/payroll-payout-evidence.routes.ts:114-128`).
- Error: 404 PAYOUT_PROOF_STUCK_NOT_FOUND, 403 PAYOUT_CLOSURE_SAME_PERSON / PAYOUT_CLOSURE_REQUESTER, 409 PAYOUT_CLOSURE_ALREADY_CLOSED, 409 PAYOUT_PROOF_CLOSED.
- Kontrak zod strict `packages/shared/src/validators/payroll-payout.ts`, DTO `packages/shared/src/types/api.ts`. Kode error baru masuk katalog teks bila repo punya (cek `tests/text-contract.test.mjs`).

## Potongan (file tidak bertumpuk)
| Potongan | Berkas |
|---|---|
| C0a | `drizzle/0644*.sql`, `drizzle/0645*.sql`, `drizzle/meta/_journal.json` (entri 0644-0647 sekaligus), snapshot, `src/db/schema/payroll-payout.ts`, `src/db/migrator-role.ts` |
| C0b | `drizzle/0646*.sql`, `drizzle/0647*.sql` (isi SQL saja; nama berkas sesuai entri journal C0a: `0646_payout_posting_source_trusted.sql`, `0647_payout_proof_closures.sql`) |
| C1a | `src/services/payroll-payout-correction.service.ts`, `payroll-payout-overpaid-route.service.ts`, `payroll-payout-overpaid.service.ts` (panggil fungsi, buang set_config) |
| C1b | `src/services/payroll-payout-manual.service.ts`, `payroll-payout-proof-binding.service.ts`, `payroll-payout-proof-backfill.service.ts` |
| C2 | `src/services/payroll-payout.service.ts` (`PayoutActor.sessionId`, mapper 23514→409, retry hold), `src/services/payroll-payout-source.service.ts`, `src/routes/payroll-payout*.routes.ts` (actorOf menambah session id) |
| C3 | router/service kartu 3 + `routes/index.ts` + shared validators/types |
| C4 | recon job + service + registrasi job + finance exception kind |
| C5 | test: `src/test/payroll-payout-905-trusted-boundary.test.ts` (sesuaikan: status item → guard 23514 bukan 42501 kecuali kolom return_* yang dicabut), baru `905-proof-closure`, `905-posting-source`, `905-recon`, `905-trusted-role-nonsuperuser`; update test 891/897/900/hardening yang memakai GUC lama |

Nama tabel nyata: lihat `brief.md` bagian Peta. Nama session table Better Auth: grep `src/db/schema`.
Aturan: hanya satu subagent menjalankan vitest/tsc pada satu waktu (token heavy: C0a dulu, lalu C5/test-runner). Potongan lain tidak menjalankan test; boleh `pnpm exec eslint`/`prettier --check` berkas sendiri.
Risiko lain: hash item-set SQL harus sama persis dengan `itemSetHashOf` (test paritas di C5); izin SQL hanya tenant-scope (aman); recon flag palsu belum bisa dibersihkan (bead lanjutan); GUC `app.payout_settle` masih dipercaya (bead lanjutan).

## Asumsi pemanggil (wajib dipenuhi fungsi SQL C0a/C0b)
- C1a: `payout_correction_propose`/`payout_overpaid_propose` mengganti proposal terbuka milik orang yang sama. `payout_correction_approve` menandai proposal corrected dan menulis `confirmation_ref` sendiri, mengembalikan jumlah item. `payout_overpaid_record` menandai proposal recorded. Hash bukti dibaca di SQL (TS tidak mengirim hash).
- C2: retry hold di `createDisbursementBatch` membaca `payroll_payout_recon_exceptions(tenant_id, item_id)`, semua baris dianggap terbuka (tanpa kolom resolved). Mapper 23514 → 409 `PAYOUT_GUARD_REFUSED`; `recordPostingSource` → 409 `PAYOUT_BATCH_STATE_CHANGED`. Engineer: hold harus per slip (payslip), bukan per item — tabel recon wajib punya kolom payslip/slip id; C2 disesuaikan setelah C0a.
- C1b: `payout_return_confirm(claim,key,actor,session)` mengembalikan jumlah item; TS memposting jurnal return sesudahnya (commit check memastikan). Return legacy tanpa claim di langkah 2 kini ditolak (lebih ketat; disetujui engineer). `payout_backfill_bind` menerima item_ids dari TS; SQL wajib hitung ulang hash item-set dan cocokkan dengan `app.payout_proof_operations()`. `contest_own` false → TS throw (fail closed).
- C3: tabel `payroll_payout_proof_closures` kolom minimal `id, tenant_id, evidence_key, proposed_at, closed_at` (+ proposed_by, closed_by, note, session). Fungsi 0647 RAISE dengan kode di teks pesan: `PAYOUT_PROOF_STUCK_NOT_FOUND`, `PAYOUT_CLOSURE_SAME_PERSON`, `PAYOUT_CLOSURE_REQUESTER`, `PAYOUT_CLOSURE_ALREADY_CLOSED`, `PAYOUT_PROOF_CLOSED`.

## Pembagian ulang C0a (engineer, 16 Nov)
C0a terlalu besar untuk satu implementer. Dibagi:
- C0a: `0644_payout_trusted_role.sql` (role, 3 tabel, grant, helper `app.payout_assert_actor`, pola owner), `drizzle/meta/_journal.json` entri 0644,0645,0646,0647,0648, `src/db/schema/payroll-payout.ts`, `src/db/migrator-role.ts`. Pemegang token heavy: buktikan 0643-0648 apply.
- C0c: `0645_payout_trusted_binding.sql`: `payout_bind_proof`, `payout_backfill_bind`, `payout_backfill_claim_hashes`, `payout_proof_contest_own` (DROP+create boolean).
- C0d: `0648_payout_trusted_transitions.sql`: correction/overpaid/return propose/approve/record/confirm, rewrite guard item (+A1), `payout_item_money_commit_check`, `payout_recon_flag`, REVOKE legend_app, drop otorisasi GUC.
Tiap berkas fungsi legend_payout mengulang pola grant SET → ALTER OWNER → revoke (lihat bagian Peran).
- C0b (0646/0647 ditulis): closures kolom `id, tenant_id, evidence_key, note, proposed_by, proposed_at, closed_at, closed_by`; attestations `kind` text menerima juga `'posting_source'`, `'closure'`; `step` text (`'propose'`,`'approve'`,`'record'`,`'confirm'`); `evidence_key`, `binding_id` nullable, `item_ids` boleh kosong. 0647 punya trigger backstop sendiri pada bindings/claims/corrections/overpaid/item `*_evidence_key` (nama trigger beda dari 0648).
- Kode error: C0a PAYOUT-39..44, C0c PAYOUT-45..49, C0b PAYOUT-50..57, C0d PAYOUT-60..69.
- C4: memanggil `app.payout_recon_flag(tenant uuid, kind text, operation uuid, item uuid, reason text)` (C0d wajib membuatnya, legend_payout, insert-only, GRANT EXECUTE legend_app dan worker). Kind finance exception `payout_recon_flag`. Batas waktu: engineer memutuskan BUKAN konstanta tanggal; 0644 membuat `app.payout_trusted_since() RETURNS timestamptz` yang mengembalikan waktu migrasi diterapkan (DO block + EXECUTE format dengan now()), C4 memakainya.
