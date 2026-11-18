// Cash-out approval through the general approval inbox (bead legend-4qowr;
// brief docs/briefs/991-akuntansi-kas-supplier.md section C and
// docs/briefs/sub-cash-out-approval.md; tier K money). Written from the briefs
// and packages/shared, not from the implementation. Real Express app, Better
// Auth, RLS and PostgreSQL on the disposable test DB.
//
// Rule: a `cash_out` above the tenant limit opens an `approval_requests` row
// (action_type `cash_out`, object_type `cash_bank_entry`, object_id = entry id)
// and has NO journal. Someone other than the creator decides it in the inbox;
// the `approval.resolved` consumer then approves or rejects the entry through
// the existing cash-bank service. Approval posts the journal exactly once;
// rejection posts nothing. At or below the limit it posts at once, with no
// approval request.
//
// Assumptions where the briefs are silent (also in the report):
// - Policy: every tenant has default `cash_out` approval policy rows (seed,
//   dev seed and migration backfill) for the `finance` role template, one
//   level, distinct actor (CTO decision 1: approver = finance, creator !=
//   approver). Missing policy is fail-closed: the submission above the limit
//   is refused with 409 APPROVAL_POLICY_MISSING, no entry, no approval
//   request, no journal.
// - Sessions that read the inbox have MFA satisfied (verifySessionMfa, as
//   other approval tests); MFA is not weakened.
// - The consumer ignores an event of another tenant silently (no throw).
// - Deciding goes through the inbox service `decideApprovalRequest` (as
//   payment-reconciliation-approval.test.ts); a decision alone changes
//   nothing on the entry. The worker consumer applies the outcome from the
//   `approval.resolved` outbox event. Its module/export follow the sibling
//   consumers: `services/cash-bank-approval-consumer.ts`,
//   `handleCashBankApprovalResolved(scope, event, now)`.
// - Deciding your own request is refused (rejects) and leaves it pending.
// - Description rule is the shared one: trimmed, 1..255 characters. "Long
//   enough after trimming" therefore means at least one non-space character;
//   blank after trimming is refused with a 4xx and an error code (400 or 422,
//   not pinned). The stored/returned description is the trimmed text.
// - A direct approve of a rejected entry is refused (409 CASH_ENTRY_NOT_PENDING)
//   for every user, including the creator (4xx).
// - The success status of a submission is 201, as the other cash-bank tests.
// - After a rejection a direct approve answers 409 CASH_ENTRY_NOT_PENDING
//   (sub-brief error codes).
//
// Isolation: the Cafe Legend tenant is shared. Only rows of this file's own
// legal entity and own GL accounts are counted. The shared limit lock keeps
// the default Rp5.000.000 in place; the missing-policy test renames the
// tenant's cash_out policy rows for a moment under the exclusive lock and
// restores them in `finally` and in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { handleCashBankApprovalResolved } from "../services/cash-bank-approval-consumer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  journalLinesOf,
  journalsByKey,
  key,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import {
  limitExclusiveLock,
  withLimitSharedLock,
} from "./helpers/cash-limit-lock.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const DEFAULT_LIMIT = 5_000_000;
const ACTION = "cash_out";

let world: World;
let creator: Session;
let approver: Session;
let approver2: Session;
let nobody: Session;

const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const foreignScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: world.foreign.tenantId,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );

/** Policy rows renamed by the missing-policy test, restored in afterAll too. */
let heldPolicyIds: string[] = [];
const HELD_ACTION = "cash_out_held_by_test";
async function restorePolicies() {
  if (heldPolicyIds.length === 0) return;
  await owner.query(
    "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND id = ANY($3::uuid[])",
    [ACTION, tenantId, heldPolicyIds],
  );
  heldPolicyIds = [];
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  creator = await signedIn(app, "CI creator", [
    { role: "finance", outletId: null },
  ]);
  approver = await signedIn(app, "CI approver", [
    { role: "finance", outletId: null },
  ]);
  approver2 = await signedIn(app, "CI approver 2", [
    { role: "finance", outletId: null },
  ]);
  nobody = await signedIn(app, "CI nobody", []);
  // The inbox read (GET /api/approvals) needs a session with MFA satisfied.
  for (const session of [creator, approver, approver2, nobody])
    await withMfa(session);
});

afterAll(async () => {
  await restorePolicies().catch(() => {});
  await closeKit();
});

// ---- helpers ---------------------------------------------------------------

/** Marks the session of `session` as MFA-verified, as other approval tests do. */
async function withMfa(session: Session): Promise<Session> {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [session.userId],
  );
  if (!rows[0]) throw new Error(`No user ${session.userId}`);
  await verifySessionMfa(rows[0].email);
  return session;
}

/** A fresh finance user: the daily anti-split total starts at zero. */
const freshCreator = async (label: string) =>
  withMfa(
    await signedIn(app, `CI ${label}`, [{ role: "finance", outletId: null }]),
  );

const post = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const directApprove = (who: Session, entryId: string) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/approve`)
    .set(originHeader)
    .send({});

const cashOutBody = (extra: Record<string, unknown> = {}) => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr: DEFAULT_LIMIT + 1,
  entryDate: daysAgo(1),
  description: "Bayar supplier besar",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

async function submitPending(
  who: Session = creator,
  extra: Record<string, unknown> = {},
) {
  const res = await post(who, cashOutBody(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.status).toBe("pending_approval");
  return res.body.data as { id: string; amountIdr: number };
}

type RequestRow = {
  id: string;
  chain_id: string;
  status: string;
  requested_by: string;
  action_type: string;
};
async function requestsOf(entryId: string): Promise<RequestRow[]> {
  const { rows } = await owner.query<RequestRow>(
    `SELECT id, chain_id, status, requested_by, action_type FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'cash_bank_entry' AND object_id = $2
      ORDER BY created_at`,
    [tenantId, entryId],
  );
  return rows;
}
async function onlyRequest(entryId: string): Promise<RequestRow> {
  const rows = await requestsOf(entryId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function entryRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approver_id: string | null;
    journal_entry_id: string | null;
  }>(
    "SELECT status, approver_id, journal_entry_id FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  expect(rows, `entry ${id}`).toHaveLength(1);
  return rows[0]!;
}

async function entryCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}
async function cashOutRequestCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approval_requests r
       JOIN cash_bank_entries e ON e.id::text = r.object_id::text
      WHERE r.tenant_id = $1 AND r.object_type = 'cash_bank_entry' AND e.legal_entity_id = $2`,
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}
async function bankNet(): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    "SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS net FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, world.gl.bankA],
  );
  return Number(rows[0]!.net);
}
const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);

async function resolvedEventOfChain(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

const inboxDecide = (
  userId: string,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    tenantContext(),
    userId,
    requestId,
    { decision, reason: "Sesuai bukti pembayaran." },
    { mfaVerified: true, idempotencyKey: null },
  );

/** Decide in the inbox, then run the worker consumer once. Returns the event. */
async function decideAndApply(
  userId: string,
  request: RequestRow,
  decision: "approved" | "rejected",
) {
  await inboxDecide(userId, request.id, decision);
  const event = await resolvedEventOfChain(request.chain_id);
  await handleCashBankApprovalResolved(tenantWide, event, new Date());
  return event;
}

// ============================================================================

describe("cash-out approval inbox: request and policy", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-1] the tenant has a default cash_out policy: finance approves, one level, distinct actor", async () => {
    const { rows } = await owner.query<{
      template_key: string | null;
      levels: number;
      requires_distinct_actor: boolean;
    }>(
      `SELECT r.template_key, p.levels, p.requires_distinct_actor
         FROM approval_policies p JOIN roles r ON r.id = p.approver_role_id
        WHERE p.tenant_id = $1 AND p.action_type = $2`,
      [tenantId, ACTION],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.template_key)).toContain("finance");
    for (const row of rows) {
      expect(row.levels).toBe(1);
      expect(row.requires_distinct_actor).toBe(true);
    }
  });

  it("[cash-out-approval-inbox-2] a cash out above the limit opens exactly one cash_out approval request with no journal, and it shows in the approver's inbox", async () => {
    const netBefore = await bankNet();
    const entry = await submitPending();
    const request = await onlyRequest(entry.id);
    expect(request).toMatchObject({
      action_type: ACTION,
      status: "pending",
      requested_by: creator.userId,
    });
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);

    const inbox = await approver.client
      .get("/api/approvals")
      .query({ status: "pending", actionType: ACTION, limit: 100 });
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(
      request.id,
    );
  });

  it("[cash-out-approval-inbox-3] a cash out at or below the limit posts at once and opens no approval request", async () => {
    for (const amountIdr of [DEFAULT_LIMIT, 150_000]) {
      // One fresh creator per amount so the daily total cannot add them up.
      const solo = await freshCreator(`inb3 ${amountIdr}`);
      const res = await post(solo, cashOutBody({ amountIdr }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.status).toBe("approved");
      expect(await journalsOf(res.body.data.id)).toHaveLength(1);
      expect(await requestsOf(res.body.data.id)).toHaveLength(0);
    }
  });

  it("[cash-out-approval-inbox-4] the same idempotency key on an above-limit submission makes one entry and one approval request", async () => {
    const entriesBefore = await entryCount();
    const body = cashOutBody({ amountIdr: 6_400_000 });
    const first = await post(creator, body);
    const second = await post(creator, body);
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await entryCount()).toBe(entriesBefore + 1);
    expect(await requestsOf(first.body.data.id)).toHaveLength(1);
  });
});

describe("cash-out approval inbox: approve posts exactly once", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-5] a decision alone moves no money; the consumer then approves the entry with one balanced journal", async () => {
    const amountIdr = 6_200_000;
    const entry = await submitPending(creator, { amountIdr });
    const request = await onlyRequest(entry.id);
    const netBefore = await bankNet();

    await inboxDecide(approver.userId, request.id, "approved");
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);

    const event = await resolvedEventOfChain(request.chain_id);
    await handleCashBankApprovalResolved(tenantWide, event, new Date());

    const after = await entryRow(entry.id);
    expect(after).toMatchObject({
      status: "approved",
      approver_id: approver.userId,
    });
    const journals = await journalsOf(entry.id);
    expect(journals).toHaveLength(1);
    expect(after.journal_entry_id).toBe(journals[0]!.id);
    const lines = await journalLinesOf(journals[0]!.id);
    const debit = lines.reduce((sum, l) => sum + l.debit, 0);
    const credit = lines.reduce((sum, l) => sum + l.credit, 0);
    expect(debit).toBe(amountIdr);
    expect(credit).toBe(debit);
    expect(await bankNet()).toBe(netBefore - amountIdr);
    expect((await onlyRequest(entry.id)).status).toBe("approved");
  });

  it("[cash-out-approval-inbox-6] replaying and racing the consumer keeps exactly one journal", async () => {
    const amountIdr = 7_100_000;
    const entry = await submitPending(creator, { amountIdr });
    const request = await onlyRequest(entry.id);
    const netBefore = await bankNet();

    await inboxDecide(approver2.userId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        handleCashBankApprovalResolved(tenantWide, event, new Date()),
      ),
    );
    await handleCashBankApprovalResolved(tenantWide, event, new Date());

    expect(await journalsOf(entry.id)).toHaveLength(1);
    expect(await bankNet()).toBe(netBefore - amountIdr);
    expect(await entryRow(entry.id)).toMatchObject({
      status: "approved",
      approver_id: approver2.userId,
    });
    // A direct approve afterwards is idempotent too: still one journal.
    const again = await directApprove(approver, entry.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await journalsOf(entry.id)).toHaveLength(1);
    expect(await bankNet()).toBe(netBefore - amountIdr);
  });

  it("[cash-out-approval-inbox-6b] a direct approve while the chain is open posts nothing (409 CASH_OUT_CHAIN_OPEN) and the chain still decides (legend-3bkvl)", async () => {
    const amountIdr = 7_400_000;
    const entry = await submitPending(creator, { amountIdr });
    const request = await onlyRequest(entry.id);
    const netBefore = await bankNet();

    const early = await directApprove(approver, entry.id);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.error.code).toBe("CASH_OUT_CHAIN_OPEN");
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
    expect((await onlyRequest(entry.id)).status).toBe("pending");

    await decideAndApply(approver.userId, request, "approved");
    expect(await journalsOf(entry.id)).toHaveLength(1);
    expect(await bankNet()).toBe(netBefore - amountIdr);
  });

  it("[cash-out-approval-inbox-6c] a pending entry without any chain cannot be approved directly (409 CASH_OUT_CHAIN_MISSING)", async () => {
    const entry = await submitPending(creator, { amountIdr: 7_500_000 });
    const netBefore = await bankNet();
    await owner.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'cash_bank_entry' AND object_id = $2",
      [tenantId, entry.id],
    );

    const res = await directApprove(approver, entry.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CASH_OUT_CHAIN_MISSING");
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
  });

  it("[cash-out-approval-inbox-7] the creator cannot decide their own request; nothing is posted and it stays pending", async () => {
    const entry = await submitPending(creator, { amountIdr: 5_900_000 });
    const request = await onlyRequest(entry.id);
    await expect(
      inboxDecide(creator.userId, request.id, "approved"),
    ).rejects.toThrow();
    expect((await onlyRequest(entry.id)).status).toBe("pending");
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);
  });

  it("[cash-out-approval-inbox-8] a user without an approver role cannot decide; nothing is posted", async () => {
    const entry = await submitPending(creator, { amountIdr: 5_800_000 });
    const request = await onlyRequest(entry.id);
    await expect(
      inboxDecide(nobody.userId, request.id, "approved"),
    ).rejects.toThrow();
    expect((await onlyRequest(entry.id)).status).toBe("pending");
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);
  });
});

describe("cash-out approval inbox: reject posts nothing", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-9] a rejection leaves the entry rejected with no journal, replays are no-ops and it cannot be approved afterwards", async () => {
    const entry = await submitPending(creator, { amountIdr: 8_000_000 });
    const request = await onlyRequest(entry.id);
    const netBefore = await bankNet();

    const event = await decideAndApply(approver.userId, request, "rejected");
    expect(await entryRow(entry.id)).toMatchObject({
      status: "rejected",
      journal_entry_id: null,
    });
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);
    expect((await onlyRequest(entry.id)).status).toBe("rejected");

    await handleCashBankApprovalResolved(tenantWide, event, new Date());
    expect((await entryRow(entry.id)).status).toBe("rejected");
    expect(await journalsOf(entry.id)).toHaveLength(0);

    const late = await directApprove(approver2, entry.id);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(late.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");
    expect(await journalsOf(entry.id)).toHaveLength(0);
  });
});

describe("cash-out approval inbox: rejected then approved directly", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-12] after a rejection in the inbox, a direct approve is refused by every finance user and nothing is posted", async () => {
    const entry = await submitPending(creator, { amountIdr: 9_100_000 });
    const request = await onlyRequest(entry.id);
    const netBefore = await bankNet();
    await decideAndApply(approver.userId, request, "rejected");
    expect((await entryRow(entry.id)).status).toBe("rejected");

    for (const who of [approver, approver2, creator]) {
      const res = await directApprove(who, entry.id);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    // The state change is also refused with the documented code for a decider.
    const again = await directApprove(approver2, entry.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");

    expect(await entryRow(entry.id)).toMatchObject({
      status: "rejected",
      journal_entry_id: null,
    });
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);
  });
});

describe("cash-out approval inbox: description is trimmed before it is checked", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-13] spaces around a long-enough description are ignored: the entry is created, stored trimmed, and above the limit it still opens an approval request", async () => {
    // At or below the limit: posts at once, description stored without the padding.
    const solo = await freshCreator("inb13a");
    const small = await post(
      solo,
      cashOutBody({
        amountIdr: 120_000,
        description: "   Bayar listrik outlet   ",
      }),
    );
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body.data.status).toBe("approved");
    expect(small.body.data.description).toBe("Bayar listrik outlet");
    expect(await journalsOf(small.body.data.id)).toHaveLength(1);

    // Above the limit: pending with one approval request.
    const big = await post(
      creator,
      cashOutBody({ description: "\t Bayar supplier besar \n" }),
    );
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body.data.status).toBe("pending_approval");
    expect(big.body.data.description).toBe("Bayar supplier besar");
    expect(await requestsOf(big.body.data.id)).toHaveLength(1);
  });

  it("[cash-out-approval-inbox-14] a description that is empty after trimming is refused clearly: 4xx with an error code, no entry, no request, no journal", async () => {
    const entriesBefore = await entryCount();
    const requestsBefore = await cashOutRequestCount();
    const netBefore = await bankNet();
    for (const amountIdr of [120_000, DEFAULT_LIMIT + 1]) {
      for (const description of ["   ", "\t\n ", ""]) {
        const solo = await freshCreator("inb14");
        const res = await post(solo, cashOutBody({ amountIdr, description }));
        expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(
          400,
        );
        expect(res.status).toBeLessThan(500);
        expect(typeof res.body.error?.code).toBe("string");
      }
    }
    expect(await entryCount()).toBe(entriesBefore);
    expect(await cashOutRequestCount()).toBe(requestsBefore);
    expect(await bankNet()).toBe(netBefore);
  });
});

describe("cash-out approval inbox: tenant isolation", () => {
  withLimitSharedLock();

  it("[cash-out-approval-inbox-10] an approval event applied in another tenant's scope changes nothing", async () => {
    const entry = await submitPending(creator, { amountIdr: 6_700_000 });
    const request = await onlyRequest(entry.id);
    await inboxDecide(approver.userId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);

    // The event is not authority: another tenant's worker scope must not apply it.
    await handleCashBankApprovalResolved(foreignScope(), event, new Date());
    expect((await entryRow(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);

    // Control: the owning tenant's scope applies it.
    await handleCashBankApprovalResolved(tenantWide, event, new Date());
    expect((await entryRow(entry.id)).status).toBe("approved");
    expect(await journalsOf(entry.id)).toHaveLength(1);
  });
});

describe("cash-out approval inbox: missing policy fails closed", () => {
  limitExclusiveLock();

  it("[cash-out-approval-inbox-11] with no cash_out policy an above-limit cash out is refused: no entry, no request, no journal", async () => {
    try {
      const { rows } = await owner.query<{ id: string }>(
        "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND action_type = $3 RETURNING id",
        [HELD_ACTION, tenantId, ACTION],
      );
      heldPolicyIds = rows.map((r) => r.id);
      // The default policy must exist, else this test proves nothing.
      expect(heldPolicyIds.length).toBeGreaterThan(0);

      const entriesBefore = await entryCount();
      const requestsBefore = await cashOutRequestCount();
      const netBefore = await bankNet();
      const res = await post(
        await freshCreator("inb11"),
        cashOutBody({ amountIdr: 6_000_000 }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_POLICY_MISSING");
      expect(await entryCount()).toBe(entriesBefore);
      expect(await cashOutRequestCount()).toBe(requestsBefore);
      expect(await bankNet()).toBe(netBefore);
    } finally {
      await restorePolicies();
    }
  });
});
