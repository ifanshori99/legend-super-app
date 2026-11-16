# 905 Payout: batas tulis tepercaya + penutupan bukti macet

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-2e31f421`, cabang `fix/payout-trusted-boundary-905` dari `a06c6bdd4`.
Migrasi baru mulai **0643** (cek `apps/api/drizzle/meta/_journal.json`). FK tabel baru inline di `CREATE TABLE`.
Sumber temuan: `docs/briefs/905/so-888-891.md` (P2 "Role aplikasi dapat memalsukan koreksi"), `docs/briefs/905/so-900.md` baris 13-14.
Aturan uang: bila ragu, batasi pembayaran. Tiap jalur uang dibuktikan test: tidak ada pihak dibayar lebih, tidak ada lunas tanpa uang.
Preseden pola: `apps/api/drizzle/0274_depreciation_correction_claim.sql` (REVOKE DML dari legend_app + fungsi SECURITY DEFINER `SET search_path = pg_catalog`, REVOKE ALL FROM PUBLIC lalu GRANT EXECUTE), role `legend_maintenance` di `0187_audit_retention_maintenance.sql`, test `SET LOCAL ROLE legend_app` di `src/test/accounting-depreciation-correction-claim.test.ts`.
Test terarah: `LEGEND_TEST_FILES="src/test/a.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread: hanya satu subagent menjalankan vitest/tsc pada satu waktu.

## Kartu 1 — legend-i01jp: batas tulis tepercaya

Peran `legend_app` saat ini bisa INSERT/UPDATE koreksi (0635 `payout failed corrections`), proposal overpaid/return, claim, binding (0637), dan UPDATE status/confirmed_* item payout. Trigger tidak bisa bedakan pemalsu dari aplikasi; GUC `app.payout_correction` disetel sendiri.
Target:

- Perpindahan status koreksi/overpaid/return lewat fungsi SECURITY DEFINER milik peran payout baru (NOLOGIN, bukan superuser). Fungsi memverifikasi aktor (user ada, anggota tenant, izin finance, dua orang beda untuk dua langkah), bukti tersimpan + hash record + binding, dan settlement/jurnal atomik. Nilai GUC bukan otorisasi.
- Cabut INSERT/UPDATE `legend_app` di tabel itu, dan UPDATE kolom status/confirmed_* item (column-level grant bila perlu).
- Rekonsiliasi detektif malam (worker job): tiap item corrected/overpaid/returned butuh dua audit row dari sesi beda dengan step-up segar, satu binding, jurnal terverifikasi; selisih jadi finance exception.
- Catatan baru: `contest_own` (0641, `payroll-payout-proof-backfill.service.ts`) percaya setelan tenant dari peran aplikasi, sehingga bisa memblokir PT lain. Perbaiki: tenant dibaca dari baris tepercaya, bukan GUC/argumen.
- Service TS diubah memanggil fungsi, bukan DML langsung.

## Kartu 2 — legend-kjht5: dua P2 residual SO-900

- INSERT posting (`0348_payout_gl_postings.sql:38` hak INSERT; guard `0642_payout_gl_commit_checks.sql:259`, `:318`) harus diperiksa keadaan akhirnya saat COMMIT (constraint trigger deferred AFTER INSERT juga), pengecualian eksplisit fee nol. Test: INSERT sebagai legend_app `kind='settle', fee_posted=true` tanpa jurnal gagal saat COMMIT (bukan ROLLBACK); kontrol dengan jurnal principal + fee benar berhasil sekali.
- Sumber historis cash/non-frozen (`0642:215`, `:73`): pengisian akun sumber yang tidak terbukti ditolak/ditahan. Test: isi akun B bukan kas asal → ditolak; kontrol sumber sah jurnal sekali.

## Kartu 3 — legend-6htrf: tutup kunci bukti macet (API + test saja)

Kunci bukti macet (unreadable, hash_conflict, legacy_duplicate, shared_key) menahan gerbang global `app.payout_proof_history_pending()` (0641) selamanya. Butuh aksi dua orang finance (password step-up, orang beda: pengusul ≠ penyetuju) untuk menutup kasus dengan bukti tetap terikat (kunci tidak bisa dipakai lagi untuk operasi lain), supaya gerbang bisa kembali false. Penutupan lewat fungsi tepercaya (pola kartu 1), audit, idempoten, tenant-scoped. Bila ragu: penutupan = kunci dibekukan permanen (tidak pernah membuka pembayaran baru atas bukti itu).

## Peta (Explore, 16 Nov)

Kartu 1 tabel: `payroll_payout_failed_corrections` (0635:47 hanya DELETE/TRUNCATE dicabut; GUC guard 0636:120,167), `payroll_payout_overpaid_proposals` (tanpa REVOKE; GUC `app.payout_overpaid` 0636:111,150), `payroll_payout_return_claims` (0381:36; insert_guard 0638:46), `payroll_payout_proof_bindings` (0637:50 INSERT terbuka; trigger 0637:84,134), `payroll_payout_proof_backfill_stuck` (0638:32), `payroll_disbursement_items` (guard status 0636:107,149,202), `payroll_payout_gl_postings` (0348:41,44; 0350:7; 0381:40; 0384:15).
contest_own: 0641 ~165-188, tenant dari `app.require_tenant_id()` (GUC), SECURITY DEFINER, arg `p_key`; dipanggil `payroll-payout-proof-backfill.service.ts:780`.
Penulis TS (apps/api/src/services): correction.service 432,516 (upd), 541 (ins), 454 (item), GUC 451,472; overpaid-route 227,267,285; overpaid.service 338 (posting), 363 (item), GUC 361,373; manual.service return ins 1242, upd 1270; item upd 425,800,983,994,1139,1384,1403,1495; gl.service 852 (item); withdraw.service 120; proof-binding 227; backfill 448 (claim), 577 (binding), stuck 287,309,836.
Kartu 2: 0642 helper `payout_settle_journal_ok` :21, `payout_fee_journal_ok` :79; BEFORE UPDATE guard :166 (source fill F4 ~:190); insert guard :259 (cash tidak dicek); commit check fn :292 trigger :317 (AFTER UPDATE saja, deferred, PAYOUT-37); journal_lines commit check :328/:368. Service INSERT posting satu-satunya gl.service:826, sumber :814-824; `fillFrozenSource` :414-432 (cash NULL tetap NULL, `resolveSource` ~443-470 => source_account_unknown). Test fixture `appTx` payroll-payout-900-gl-commit.test.ts:226, salin posting via INSERT...SELECT :340-360, `W.asTenant(fn,true)` owner.
Kartu 3: tabel stuck 0638:10-23 (reason, resolved_at, unique tenant+evidence_key), reason diperluas 0641:3 (shared_key, bind_failed); schema `src/db/schema/payroll-payout.ts:1235-1283`; legacy_duplicate binding flag 0637:24, trigger 0637:99, 0640:29; contests 0640:15; backfill markStuck :292 (shared_key tidak ditimpa), unreadable :214, hash_conflict :233, legacy_duplicate :600, shared_key :652; worker `src/worker/payout-evidence-backfill.job.ts`. Gerbang 0641:92 (tenant_pending), :136-152 (global). Daftar finance `GET /finance-exceptions` (`accounting-finance-exceptions.service.ts:693` `payout_proof_stuck`). Pola dua orang + step-up: `routes/payroll-payout-evidence.routes.ts:114-128` izin `payroll.disburse.approve`, `requireTenantStepUpPassword` (`middleware/identity.ts:173`), proposer≠approver `payroll-payout-overpaid-route.service.ts:192,274`; test `payroll-payout-888-stepup.test.ts`, `payroll-payout-888-overpaid-route.test.ts:510`.

## Implementasi kartu 2 (implementer K2) — migrasi 0643 saja

- Berkas: `apps/api/drizzle/0643_payout_gl_insert_commit_check.sql` + `drizzle/meta` (journal + snapshot via `pnpm db:generate --custom`/cara repo untuk migrasi SQL kustom; lihat bagaimana 0642 didaftarkan). Jangan sentuh berkas kartu 1/3.
- (a) CONSTRAINT TRIGGER baru AFTER INSERT DEFERRABLE INITIALLY DEFERRED pada `payroll_payout_gl_postings`: `kind='settle'` → `app.payout_settle_journal_ok`; `fee_posted=true AND fee_idr>0` → `app.payout_fee_journal_ok`; `fee_posted=true AND fee_idr=0` dikecualikan eksplisit. Pola tenant set_config sama dengan `payroll_payout_gl_postings_commit_check` (0642:292). Kode PAYOUT-37.
- (b) Guard UPDATE (0642 `payroll_payout_gl_postings_guard`, CREATE OR REPLACE di 0643): cabang source fill ELSE (cash / bank tak beku) → tolak (hold) kecuali sumber terbukti; bila ragu tolak. Periksa service `fillFrozenSource`/`resolveSource` (gl.service ~414-470) tetap jalan.
- Test: `src/test/payroll-payout-905-gl-insert.test.ts` (7 merah harus hijau) + suite 900/0639 GL yang ada tetap hijau. Jalankan lewat `LEGEND_TEST_FILES=... heavy pnpm test` (pegang token heavy sendiri).
- Status K2 (16 Nov): (a) selesai di 0643 (journal idx 401). (b) keputusan engineer: opsi 1, `recordPostingSource` (endpoint finance, 881) lewat fungsi SECURITY DEFINER peran payout (pola kartu 1), lalu cabang ELSE guard ditolak untuk legend_app. Menunggu desain architect untuk nama peran.
