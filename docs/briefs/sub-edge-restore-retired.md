# legend-sduiq: restored edge keeps numbering a cloud-retired run

Branch `ws/edge-restore-retired` from `b6d6c8b4` (legend-yd0h8 tip). Tier K (receipt numbers, POS-06).

## Problem

The cloud rotates a device run (legend-yd0h8 `edge_regressed`, or any rotation) and lists only the new run for the edge's binding (N, I). The edge's apply refuses the new run when its prefix or id already exists locally, or when the cloud run is already at L > 0 (3yqy backstop). Before this fix, the local current run then stayed current and kept numbering a run the cloud had retired: the restored/cloned database reissues numbers.

## Options from the card

- **A. Apply retires unlisted runs (chosen).** After a page's sequences are applied, the edge retires every local current device run usable here (bound to `own`, or unbound) whose id is not in the pulled list.
- **B. Allocation refuses runs absent from the last successful pull.** Rejected:
  - It needs the last pull's id list stored on the edge (new table or state, likely a migration).
  - It adds a read to every sale.
  - It gets the first-boot / offline-before-first-pull semantics wrong.
  - It duplicates what A gets for free: the list is already complete on every page.

## Why A is safe

- The cloud list (`listDeviceReceiptSequences`) is complete. It holds every current device run of the outlet bound to exactly (N, I), and the same request's claim binds or rotates all of them first. Edges never invent runs. So a local run missing from a non-empty list is one the cloud no longer considers current for this database.
- An empty list is ambiguous: the cloud may not have recognised this database as primary with an instance (binding null, so no claim). An empty list never retires anything.
- A list refused whole (bad shape, other outlet) throws before any write. Retire runs in the same transaction as the apply.
- Only a primary with a binding applies, as before. A standby never retires.
- Rows bound to another binding (old instance after the zsdd restore procedure) are not touched. They already cannot number (`boundToThisDatabase`).
- The cloud-owned `C` run is excluded (`device_id <> outlet_id`).
- Reason `edge_replaced`, already allowed by the check constraint and trigger, so no migration.
- Consequence: the device then has no current run and its sales are refused (`RECEIPT_SEQUENCE_NOT_PROVISIONED`) until a later pull delivers a run the edge accepts. This is fail-closed for POS-06. A clone stays an alarm (legend-yd0h8) plus the manual zsdd procedure.

## Files

- `apps/api/src/services/pos-receipt.service.ts`: `retireUnlistedDeviceReceiptSequences`.
- `apps/api/src/services/edge-device-sync.ts`:
  - `applyDeviceReceiptSequences` calls the new function.
  - Adds `retired` to the apply result and `receiptSequencesRetired` to the pull result.
  - Adds a warn log (counts only).
- `apps/api/src/test/pos-receipt-seq-edge.test.ts`:
  - The zsdd-R1 "advanced replacement" test now expects the old run to be retired. This is the repro, and it failed before the fix.
  - New `sduiq` describe block.
