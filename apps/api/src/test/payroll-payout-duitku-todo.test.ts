// Duitku-only payout rules (design docs/design/payroll-disbursement.md section 6),
// not buildable in bead legend-648 (the Duitku adapter, worker, reconciler and
// callback are card .3, GL posting and payroll.paid are card .5). Each rule
// keeps its text here so the later cards turn the todo into a test BEFORE the
// code. Tests must never call the real Duitku: inject a fake fetch with
// fixtures from the Duitku docs.
import { describe, it } from "vitest";

describe("Duitku payout rules (todo, cards .3 and .5)", () => {
  it.todo(
    "R2 timeout never resends: a fake fetch that times out leaves the item `unknown`, zero second transfer calls, 'retry' is refused 409 (only for `failed` items)",
  );
  it.todo(
    "R2 a `sending` item older than 2 minutes without a result becomes `unknown` without calling the provider",
  );
  it.todo(
    "R3 inquiry account name must equal the employee legal name after normalization (upper case, punctuation removed, spaces collapsed): one letter off -> item `blocked` (name_mismatch) then `cancelled`, zero transfers; HR changing the account to their own: inquiry name differs, zero transfers; the approver cannot override",
  );
  it.todo(
    "R4 inquiry is repeated right before sending: a changed name or amount between approval and send makes the item `failed` (definitive), zero transfers; the disburseId of that inquiry is stored in the same commit as the CAS to `sending`; `sending` and `unknown` items are never re-inquired",
  );
  it.todo(
    "R6 balance short by Rp1: batch `halted` (insufficient_balance), zero transfers; code -510 on item 3 of 5: items 1-2 `succeeded`, 3 `failed`, 4-5 stay `approved` and are not sent",
  );
  it.todo(
    "R1 (Duitku) two workers on one batch: exactly one transfer call per item (CAS approved -> sending committed before HTTP)",
  );
  it.todo(
    "R11 (worker) a run reversed by another path before sending: the worker stops (reads the run row FOR SHARE, status must be locked or paid), zero transfers",
  );
  it.todo(
    "R12 an `unknown` item is resolved to succeeded/failed only by two different people with evidence (resolved_by, resolved_by2), `failed` earliest T+1 business day; one person alone is refused by the database",
  );
  it.todo(
    "R13 a new attempt after an `unknown` resolved as failed: one inquiryStatus on the old attempt first; a fake `00` cancels the new attempt and marks the old one `succeeded`; a late `00` afterwards makes the item `overpaid` with a receivable journal and a notification",
  );
  it.todo(
    "late success: a late `00` for a `failed` item whose slip has no live attempt becomes `succeeded` and raises incident PAYOUT_LATE_SUCCESS",
  );
  it.todo(
    "R15 (Duitku) safeguards are checked before each item: kill switch PAYROLL_DISBURSEMENT_ENABLED switched off mid batch -> next items not sent, batch `halted` (kill_switch); per-PT enabled, worker lease, run status and daily cap too",
  );
  it.todo(
    "R10 GL once: settle triggered twice concurrently posts one journal (key payroll-payout:<item_set_hash>); sum of credits = sum of net pay of the paid slips; the legacy 'mark paid' on a run with a batch is 409 PAYROLL_RUN_HAS_PAYOUT_BATCH; payroll.paid with settledPerItem=true posts nothing",
  );
  it.todo(
    "callback: signature verified with timingSafeEqual, deduplicated, payload (account HMAC, amount, disburseId) must equal the item, a callback cannot move `succeeded` backwards",
  );
});
