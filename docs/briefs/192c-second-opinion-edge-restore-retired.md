# Brief: second-opinion — an edge stops numbering a run the cloud retired (legend-sduiq)

## Role
Read `~/.agents/team/roles/second-opinion.md` and follow it.

## Repo
- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-retired`
- Branch: `ws/edge-restore-retired`
- Diff range: `git diff b6d6c8b4..ws/edge-restore-retired`. The base is the tip of `ws/edge-restore-detect` (legend-yd0h8). Ignore `docs/`.
- Design and the option choice (A vs B): `docs/briefs/sub-edge-restore-retired.md` in that worktree. Context:
  - `docs/briefs/sub-edge-restore-detect.md` (yd0h8)
  - `docs/briefs/sub-receipt-seq-edge.md` (zsdd)

## Risky files
- `apps/api/src/services/pos-receipt.service.ts`:
  - `retireUnlistedDeviceReceiptSequences`, the new function.
  - Related: `applyCloudDeviceReceiptSequence`, `listDeviceReceiptSequences`, `claimDeviceReceiptSequencesForEdge`, `ensureSequence`.
- `apps/api/src/services/edge-device-sync.ts`: `applyDeviceReceiptSequences`, `pullDeviceRegistry`, `listDeviceRecordsSince`.
- Edge status `receiptSequencesRetired(+At)`: `apps/api/src/edge/device-registry-puller.ts`, `apps/api/src/services/edge-status.service.ts`, `packages/shared/src/edge/endpoints.ts` (strict schema, optional fields).
- Tests:
  - `apps/api/src/test/pos-receipt-seq-edge.test.ts` (the `sduiq` describe, plus the zsdd-R1 test that changed).
  - `pos-receipt-restore-detect.test.ts` (`shipTo` id is now stable).
  - `pos-receipt-provisioning.test.ts` (the list is now full).

## Invariants (PRD)
- POS-06 / §3 F8: a receipt number is never issued twice in one outlet. Numbers run in order per device. A void does not give a number back.
- An edge never numbers on a run that the cloud has retired, including when the edge refuses the replacement run (prefix or id clash, or the cloud run is already above 0).
- A normal edge (full list, every run accepted) never loses its run. An empty list, a refused list, or a standby never retires anything.
- EDG-02: the device registry pull never stops because of receipt sequences.
- TEN-01/TEN-02: tenant and outlet come only from the verified edge credential.
- No migration (reason `edge_replaced` is reused).
- Review K is already fixed (see the "Review K" section in `sub-edge-restore-retired.md`); look for anything that is still left.
- Known limit, not a finding: a device whose replacement is refused stays unable to sell (RECEIPT_SEQUENCE_NOT_PROVISIONED) until a later pull brings a run the edge accepts, or the manual zsdd procedure is run. A clone remains an alarm.

## Effort
xhigh.

## Report
One line per finding: `path:line`, severity, problem, failure scenario, suggested fix. No findings: one line.

## Do not
Do not edit or commit. Do not read `.env*` or `~/.ssh`.
