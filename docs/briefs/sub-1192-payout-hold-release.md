# Sub-brief 1192: lepas hold payout dua orang + tampil di finance exceptions (legend-6o7pc)

Cabang `ws/1192-payout-hold-release` dari d58a535de. Tingkat K (uang). Aturan: bila ragu, slip tetap ditahan. Migrasi 0710-0712 (tulis ulang fungsi 0709 hanya lewat migrasi baru; 0709 sudah di cabang 1179). Jangan sentuh: `payment-webhook*`, `order-given.ts`, `reservation-*`, `edge-*`, `access.service.ts`, `sole-owner-self-approval.ts`, `hris-*` (kecuali yang tertulis di sini: routes/services payroll-payout-*).
Latar: 0709 menambah `payroll_payout_recon_unwritten_holds` (hold per item saat flag tak bisa ditulis; tak bisa diubah/dihapus PAYOUT-87; diambil alih hanya bila flag sama (kind, operation, item, reason) ditulis kemudian). Flag kunci (`evidence_read_locked:<hari>`) tidak ditulis ulang di hari lain -> hold macet. Dokumen terkait: `docs/briefs/sub-1179-payout-so1173.md`, `drizzle/0709_payout_t1ufu_hold_unwritten.sql`.

## Bagian 1: SQL (0710, 0711 bila perlu), schema, snapshot, registry
a. `app.payout_recon_hold_unwritten` mengembalikan `integer`: jumlah item DISTINCT dari `p_items` yang SESUDAH panggilan punya hold yang belum diambil alih (baris baru + hold lama yang masih menahan). DROP FUNCTION lalu CREATE (tipe kembalian berubah; owner `legend_payout`, GRANT `legend_payout_recon` seperti 0709, REVOKE lainnya). Service: `holdUnwrittenFlags` = true hanya bila untuk tiap group jumlah == jumlah item distinct group (bukan sekadar tidak melempar).
b. Tabel `payroll_payout_recon_hold_releases` (insert + approve satu kali, tiru `payroll_payout_recon_clearances` di 0460: UNIQUE per hold, CHECK, guard insert-only/tak bisa dihapus, RLS tenant, hanya `legend_payout` DML, `legend_app` SELECT): `id`, `tenant_id`, `hold_id` (FK komposit ke holds: tambah `UNIQUE(tenant_id, id)` di tabel holds lewat ALTER TABLE ADD CONSTRAINT UNIQUE, FK baru di dalam CREATE TABLE), `reason` (10..500), `proposed_by`, `proposed_at`, `approved_by`, `approved_at`, `basis` ('flag_rewritten'|'clean_evidence'|null sampai disetujui). Index (tenant_id, hold_id).
c. Fungsi (SECURITY DEFINER, owner legend_payout, GRANT `legend_app`): `app.payout_recon_hold_release_propose(p_tenant uuid, p_hold uuid, p_reason text) RETURNS uuid` dan `app.payout_recon_hold_release_approve(p_tenant uuid, p_release uuid) RETURNS uuid`. Tiru `payout_recon_clear_propose/approve` (0464/0708): tenant check PAYOUT-68, peran Owner/Finance Manager tenant-wide (PAYOUT-42), self-approval PAYOUT-86, sudah disetujui PAYOUT-87, propose idempoten (ON CONFLICT DO NOTHING lalu baca ulang, tidak duplikat; usulan baru ditolak bila sudah ada release disetujui untuk hold itu). Kondisi lepas (diperiksa di PROPOSE dan di APPROVE, yang otoritatif, di bawah kunci): hold belum diambil alih DAN (a) flag (kind, operation, item, reason-base atau reason#n) kini ada dan sudah ditulis (basis 'flag_rewritten', tidak perlu release: tolak dengan PAYOUT-96 "hold sudah diambil alih flag") ATAU (b) observasi bukti terbaru operasi itu `state='ok'` dengan `observed_at > hold.created_at` (basis 'clean_evidence'). Selain itu PAYOUT-97 (hold tetap, bukti belum bersih). Catatan: bila (a) berlaku hold sudah inert; propose tetap boleh ditolak 96.
d. `app.payout_payslip_held_by_recon` (isi 0709 + satu klausa): hold tidak menahan bila ada release disetujui (`approved_at IS NOT NULL`) untuk hold itu. Signature/owner/ACL tetap.
e. `src/db/schema/payroll-payout.ts` (tabel baru + unique), `drizzle/meta/_journal.json`, snapshot 0710 (dan 0711), `src/test/data-import-registry.test.ts`. `db:generate` harus kosong.

## Bagian 2: API
- `packages/shared/src/validators/payroll-payout-recon-hold.ts` (baru; daftarkan subpath di `packages/shared/package.json`): `payoutReconHoldParamsSchema {holdId}`, `payoutReconHoldReleaseParamsSchema {releaseId}`, `proposePayoutReconHoldReleaseInputSchema {password?, reason trim 10..500}`, `approvePayoutReconHoldReleaseInputSchema {password?}` (strictObject, tiru clearance).
- DTO di `packages/shared/src/types/api.ts` (tepat ini):
```ts
export type PayoutReconHoldDto = {
  id: string;
  kind: string;
  itemId: string;
  payslipId: string;
  batchId: string;
  /** Base reason of the flag that could not be written (null when unknown). */
  reason: string | null;
  /** ISO datetime the hold was made. */
  heldAt: string;
  /** True when a later flag took the hold over (the flag + its clearance decide now). */
  takenOver: boolean;
  /** True when the latest recon evidence of the operation is clean after the hold (a release can be proposed). */
  releasable: boolean;
  release: { id: string; status: "proposed" | "approved"; reason: string; proposedBy: string; proposedAt: string; approvedBy: string | null; approvedAt: string | null } | null;
};
```
- `apps/api/src/services/payroll-payout-recon-hold.service.ts`: `listPayoutReconHolds`, `proposePayoutReconHoldRelease`, `approvePayoutReconHoldRelease` (tiru `payroll-payout-recon-clearance.service.ts`: grant `payoutGrantIssuerOf`, audit `recordPayoutAudit` aksi `payroll.disbursement.recon_hold_release_proposed` / `recon_hold_release_approved`, propose idempoten tanpa audit ganda, pemetaan error di `payroll-payout-grant.service.ts` ~146-159 untuk PAYOUT-96/97 -> 409 kode `PAYOUT_RECON_HOLD_TAKEN_OVER` / `PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN`). Tanpa nama/rekening/jumlah.
- Route `apps/api/src/routes/payroll-payout-recon-hold.routes.ts` (daftar di `routes/index.ts` di bawah `/hris/payroll` seperti clearance): `GET /payout-recon-holds`, `POST /payout-recon-holds/:holdId/release`, `POST /payout-recon-hold-releases/:releaseId/approve`. Middleware sama persis dengan clearance: `payroll.disburse.approve`, `requireTenantStepUpMfa({maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES})`, `requireTenantStepUpPassword({passwordOnly:true})`, `requireTrustedOrigin`, `jsonBody`, `payoutGuardErrorMapper`.
- Finance exceptions: kind baru `payout_recon_hold` di `packages/shared/src/validators/finance-exceptions.ts`; collector baru di `accounting-finance-exceptions.service.ts` (di samping `payoutReconFlags` ~837; hold yang belum diambil alih dan belum dilepas; tiru bentuk Collected `payout_recon_flag`, ref_type `payout_recon_hold`, tanpa PII), disertakan di `listFinanceExceptions` dengan syarat yang sama dengan flag.

## Bagian 3: Web (ikut pola layar yang ada, tanpa pola baru; ~/.agents/team/ui-standard.md)
- Daftar hold + aksi usul/setujui di layar rekonsiliasi payout yang ada (`features/ws10-payroll-payout/components/recon-*.tsx`, route `kelola.payroll.rekonsiliasi.tsx`): satu bagian "Hold slip" di bawah daftar flag (tiru `recon-list/recon-panel/recon-forms`: status Ditahan / Diusulkan lepas / Dilepas / Sudah diambil alih flag, tombol usul hanya bila `releasable`, tombol setujui nonaktif dengan penjelasan untuk pengusul sendiri (bandingkan `proposedBy` dengan `currentUserId`), password step-up di dialog dan dikosongkan, alasan wajib 10..500, 409 -> muat ulang). Data: api.ts -> queries.ts -> hooks.ts (`usePayoutReconHolds`, `useProposeReconHoldRelease`, `useApproveReconHoldRelease`), errors.ts untuk PAYOUT_RECON_HOLD_*; mock scenario ikut mekanisme yang ada (`isMockScenarioRequest`, normal/empty/error/approve/self/taken-over).
- Finance exceptions: `features/ws07-finance-exceptions/lib.ts` (peta label kind + refType) mengenal `payout_recon_hold`, tautan ke layar rekonsiliasi.
- Teks hanya lewat katalog: `packages/shared/src/i18n/messages/ws10-payroll-payout-review.ts` (sub-objek `reconHold`) dan `ws07-finance-exceptions.ts`; sisip dengan Edit, jangan Write ulang; `node --test tests/text-contract.test.mjs` lulus.
- Screenshot 390 dan 1280 (terang; gelap bila pola ui1015 ada) via `heavy --browser`, ke `docs/review/img/ui1192-recon-hold-<state>-<width>-<tema>.png` (state: normal, empty, error, approve, self, taken-over). E2E mock: `e2e/payout-recon-hold.mock.spec.ts` meniru `e2e/payout*.mock.spec.ts` (`pnpm test:e2e:mock`, role cookie `finance`, `payoutMockStepUp=password`, password `benar-123`). Test web `apps/web/test/*.test.ts` (renderToString).

## Aturan eksekusi
Satu eksekutor heavy per thread: agen induk menjalankan tsc/test penuh; subagent hanya `LEGEND_TEST_FILES=... heavy pnpm test` terarah dari root worktree. Jangan commit. Test-writer menulis test gagal-dulu (sebab benar) sebelum implementer menjalankan test.

## Status WIP (usage limit, 19 Nov): BELUM SIAP, jangan merge
Sudah: 0710-0712, service, routes, shared, web, test API (41 lulus), test web (88 lulus). Belum: tsc, e2e, screenshot ui1192, db:generate.
Architect xhigh: P0 + 2 P1, WAJIB dibetulkan sebelum siap:
- P0 (0712:51-55): status `clean` abaikan `h.reason`; batasi ke reason evidence_missing / evidence_hash_mismatch / evidence_read_locked:%; selain itu unclean (termasuk NULL).
- P1a: observasi `ok` tidak tercatat (dedupe/ok pertama), jadi hold lock tak pernah clean. Buat tabel insert-only `payroll_payout_recon_hold_clean_reads` + fungsi definer (GRANT legend_payout_recon) dipanggil di `recordReadOk` (recon.service ~2509) selama ada hold aktif; clean = read_at > hold.created_at dan observasi terakhir (bila ada) ok. Jangan tulis baris ok ganda ke observations.
- P1b (0710:120-148): dedupe hold_unwritten hanya terhadap hold reason sama, tanpa release, dibuat sesudah clean read terakhir; advisory lock `payout_recon_hold:<tenant>:<operation>` di hold_unwritten, propose, approve (bukan kunci observe).
- P2: hapus index dobel `payroll_payout_recon_hold_releases_hold_idx` (schema, snapshot, SQL).
Test gagal-dulu: hold net_mismatch + bukti ok -> 409; lock dengan ok sebelumnya lalu baca ok bisa dilepas; kegagalan sesudah usulan tetap menahan slip sesudah approve.
