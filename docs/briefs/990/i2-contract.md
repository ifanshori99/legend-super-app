# I2 kontrak A-api (path final)

Mount `/api/hris/payroll` (konvensi rute payout), guard `payroll.disburse.approve`.

- `GET  /api/hris/payroll/payout-recon-flags` -> 200 `{data: PayoutReconFlagDto[]}` (maks 200, terbaru dulu; `clearance` null / `status` proposed|approved).
- `POST /api/hris/payroll/payout-recon-flags/:flagId/clearance` body `{reason (10-500), password}` -> 201 `{data:{clearanceId}}`. Step-up MFA + password-only, seperti unfreeze.
- `POST /api/hris/payroll/payout-recon-clearances/:clearanceId/approve` body `{password}` -> 200 `{data:{clearanceId}}`.

Error: flag/clearance tenant lain atau id salah 404 (PAYOUT_RECON_FLAG_NOT_FOUND / PAYOUT_RECON_CLEARANCE_NOT_FOUND); usulan terbuka diulang: 201 dengan id yang sama (idempoten, alasan pertama tetap); sudah disetujui 409 PAYOUT_RECON_CLEAR_STATE; PAYOUT-42 403 PAYOUT_ACTOR_REFUSED; PAYOUT-72 422 PAYOUT_GRANT_REFUSED; PAYOUT-70 409 PAYOUT_STEP_GRANT_INVALID; PAYOUT-69 404; PAYOUT-85 422 PAYOUT_RECON_CLEAR_REASON_INVALID; PAYOUT-86 403 PAYOUT_RECON_CLEAR_SELF_APPROVAL; PAYOUT-87 409 PAYOUT_RECON_CLEAR_STATE.

SQL dipanggil: `app.payout_recon_clear_propose(uuid flag, text grant, text reason) -> uuid`, `app.payout_recon_clear_approve(uuid clearance, text grant)`. Grant `recon_clear`: propose refId=flagId, approve refId=clearanceId, detail=sha256(reason trim), batchId=batch item flag, itemIds [].
Audit: `payroll.disbursement.recon_clear_proposed` / `_approved`.
Tidak diubah: endpoint katalog `payout-endpoints.ts` (I6/web belum butuh).
