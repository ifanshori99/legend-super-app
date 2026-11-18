// SO 1036 finding 6 (card legend-6ipij, tier K money): a petty cash top-up held
// above the cash limit must open an approval chain in the inbox, move no money
// until the whole chain is approved, and obey the matrix. Written from
// docs/qa/second-opinion-payout-kas-1036.md (finding 6), docs/briefs/1037-ctx.md,
// docs/briefs/sub-cash-out-approval.md, and the shared approval matrix contract
// (packages/shared/src/access/approval.ts), not from the implementation. Real
// Express app, Better Auth, RLS and PostgreSQL on the disposable test DB.
//
// Scenarios (SO-6-n):
//   1 above-limit top-up opens an open chain (one request per matrix level)
//     that shows in the finance approver's inbox; no fund, no journal
//   2 the direct approve route cannot bypass the open chain
//   3 creator, a person without the role, the wrong-level role and a repeat
//     decider cannot decide; nothing moves
//   4 after every level: fund + amount, exactly one journal; replays and a race
//     of the consumer keep it at one
//   5 a rejection moves nothing; a direct approve after it is refused
//   6 another tenant is blind (event in a foreign scope changes nothing)
//   7 no cash_out policy: the top-up is refused, no pending document (fail closed)
//   8 same idempotency key: one entry, one chain
//
// Assumptions where the spec is silent (also in the report):
// - Finding 6 says the top-up must open a `cash_out` request "like the cash
//   out path": action_type `cash_out`, object_type `cash_bank_entry`,
//   object_id = the pending entry id (the pending top-up is a
//   cash_bank_entries row of kind `petty_topup`, as accounting-petty-cash tests
//   read it). A multi-level chain is one approval_requests row per level, same
//   chain_id (as profit-share-approval-chain.test.ts).
// - The matrix is the tenant's `cash_out` policy: tier floor Rp7.000.000 with
//   level 1 = finance and level 2 = owner, distinct actor. The top-up amount
//   Rp7.500.000 picks that tier (highest applicable) and is above the default
//   cash limit Rp5.000.000. The tier rows are inserted and removed inside each
//   test under the exclusive limit lock; the default finance tier (floor 0)
//   stays untouched.
// - After the last level the `approval.resolved` outbox event is applied by
//   `handleCashBankApprovalResolved` (same object type as cash out). Then the
//   fund grows by the amount and one `petty_cash_topup` journal exists for the
//   outlet, Dr petty cash GL / Cr the bank account's own GL, balanced.
// - A refused decision (service throws) leaves the chain pending. The direct
//   approve route (`POST /api/accounting/cash-bank/entries/:id/approve`) must
//   answer 4xx (not pinned) while the chain is open; only "nothing moved and
//   the entry is still pending_approval" is pinned beyond that.
// - A missing policy answers 409 APPROVAL_POLICY_MISSING (as cash out), no
//   pending entry, no fund, no journal.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  key,
  makeOutlet,
  makeWorld,
  owner,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import { limitExclusiveLock } from "./helpers/cash-limit-lock.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const ENTRIES = "/api/accounting/cash-bank/entries";
const ACTION = "cash_out";
/** Above the default cash limit (Rp5.000.000) and in the two-level tier. */
const AMOUNT = 7_500_000;
const TIER_FLOOR = 7_000_000;

let world: World;
let creator: Session;
let finance2: Session;
let finance3: Session;
let ownerUser: Session;
let nobody: Session;

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

async function withMfa(session: Session): Promise<Session> {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [session.userId],
  );
  if (!rows[0]) throw new Error(`No user ${session.userId}`);
  await verifySessionMfa(rows[0].email);
  return session;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  const user = (name: string, role: string | null) =>
    signedIn(app, `SO6 ${name}`, role ? [{ role, outletId: null }] : []).then(
      withMfa,
    );
  creator = await user("creator", "finance");
  finance2 = await user("finance 2", "finance");
  finance3 = await user("finance 3", "finance");
  ownerUser = await user("owner", "owner");
  nobody = await user("nobody", null);
});

let heldPolicyIds: string[] = [];
let tierRowIds: string[] = [];
const HELD_ACTION = "cash_out_held_by_so6_test";
async function cleanupPolicies() {
  if (tierRowIds.length > 0)
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, tierRowIds],
    );
  tierRowIds = [];
  if (heldPolicyIds.length > 0)
    await owner.query(
      "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND id = ANY($3::uuid[])",
      [ACTION, tenantId, heldPolicyIds],
    );
  heldPolicyIds = [];
}

afterAll(async () => {
  await cleanupPolicies().catch(() => {});
  await closeKit();
});

async function roleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  return rows[0]!.id;
}

/** Tier from Rp7.000.000: level 1 finance, level 2 owner, distinct actor. */
async function twoLevelMatrix() {
  const rows = [
    { level: 1, role: await roleId("finance") },
    { level: 2, role: await roleId("owner") },
  ];
  for (const row of rows) {
    const res = await owner.query<{ id: string }>(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [tenantId, ACTION, TIER_FLOOR, row.role, row.level],
    );
    tierRowIds.push(res.rows[0]!.id);
  }
}

// ---- requests --------------------------------------------------------------

const movementBody = (
  outletId: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "topup",
  outletId,
  bankAccountId: world.bankAccountA,
  amountIdr: AMOUNT,
  description: "Isi kas kecil besar",
  idempotencyKey: key(),
  ...extra,
});
const move = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send(body as object);
const directApprove = (who: Session, entryId: string) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/approve`)
    .set(originHeader)
    .send({});

/** A fresh outlet and a submitted, held top-up of AMOUNT. */
async function submitHeld(extra: Record<string, unknown> = {}) {
  const outletId = await makeOutlet(world.entityId);
  const res = await move(creator, movementBody(outletId, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(res.body.data).toMatchObject({
    kind: "petty_topup",
    status: "pending_approval",
    journalEntryId: null,
  });
  return { outletId, entryId: res.body.data.id as string };
}

// ---- reads (migration owner) -----------------------------------------------

type RequestRow = {
  id: string;
  chain_id: string;
  status: string;
  level: number;
  required_levels: number;
  requested_by: string;
  action_type: string;
};
async function requestsOf(entryId: string): Promise<RequestRow[]> {
  const { rows } = await owner.query<RequestRow>(
    `SELECT id, chain_id, status, level, required_levels, requested_by, action_type FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'cash_bank_entry' AND object_id = $2
      ORDER BY level, created_at`,
    [tenantId, entryId],
  );
  return rows;
}
async function entryStatus(entryId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, entryId],
  );
  expect(rows, `entry ${entryId}`).toHaveLength(1);
  return rows[0]!.status;
}
async function fundBalance(outletId: string): Promise<number | null> {
  const { rows } = await owner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? Number(rows[0].balance) : null;
}
async function topupJournals(outletId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND outlet_id = $3
        AND source_type = 'petty_cash_topup'`,
    [tenantId, world.entityId, outletId],
  );
  return rows;
}
async function glNet(accountId: string): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    "SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS net FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, accountId],
  );
  return Number(rows[0]!.net);
}
async function topupEntryCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND outlet_id = $2 AND kind = 'petty_topup'",
    [tenantId, outletId],
  );
  return Number(rows[0]!.n);
}

/** Nothing moved: no fund, no journal, still held, GL untouched. */
async function expectNothingMoved(
  outletId: string,
  entryId: string,
  glBefore: { petty: number; bank: number },
) {
  expect(await fundBalance(outletId)).toBeNull();
  expect(await topupJournals(outletId)).toHaveLength(0);
  expect(await entryStatus(entryId)).toBe("pending_approval");
  expect(await glNet(world.gl.pettyCash)).toBe(glBefore.petty);
  expect(await glNet(world.gl.bankA)).toBe(glBefore.bank);
}
const glSnapshot = async () => ({
  petty: await glNet(world.gl.pettyCash),
  bank: await glNet(world.gl.bankA),
});

const inboxDecide = (
  who: Session,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    who.userId,
    requestId,
    { decision, reason: "Sesuai bukti isi kas kecil." },
    { mfaVerified: true, idempotencyKey: null },
  );

/**
 * The chain the submit opened. The platform approval opens level 1 only; the
 * next level's request is created when the previous one is decided, so the
 * chain's length shows in `required_levels`, not in the row count.
 */
async function chainOf(entryId: string): Promise<string> {
  const requests = await requestsOf(entryId);
  expect(requests, "level 1 of the chain is open").toHaveLength(1);
  expect(
    requests[0]!.required_levels,
    "the held top-up opened a two-level approval chain",
  ).toBe(2);
  return requests[0]!.chain_id;
}

async function openLevel(entryId: string): Promise<RequestRow> {
  const next = (await requestsOf(entryId)).find((r) => r.status === "pending");
  if (!next) throw new Error("No pending approval level");
  return next;
}

async function resolvedEvent(chainId: string) {
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

// ============================================================================

describe("SO 1036 finding 6: held petty top-up goes through the approval chain", () => {
  limitExclusiveLock();
  // Remove this test's matrix tier before the next test and before the lock goes.
  afterEach(cleanupPolicies);

  it("[so1036-petty-topup-SO-6-1] an above-limit top-up opens a two-level chain at level 1, shows in the finance inbox, and moves no money", async () => {
    await twoLevelMatrix();
    const before = await glSnapshot();
    const { outletId, entryId } = await submitHeld();

    await chainOf(entryId);
    const requests = await requestsOf(entryId);
    expect(requests.map((r) => r.level)).toEqual([1]);
    expect(requests[0]!.required_levels).toBe(2);
    for (const request of requests)
      expect(request).toMatchObject({
        action_type: ACTION,
        status: "pending",
        requested_by: creator.userId,
      });

    const inbox = await finance2.client
      .get("/api/approvals")
      .query({ status: "pending", actionType: ACTION, limit: 100 });
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(
      requests[0]!.id,
    );

    await expectNothingMoved(outletId, entryId, before);
  });

  it("[so1036-petty-topup-SO-6-2] the direct approve route cannot bypass the open chain: not after level 1 either, and nothing posts", async () => {
    await twoLevelMatrix();
    const before = await glSnapshot();
    const { outletId, entryId } = await submitHeld();

    // A finance user who is not the creator, with the chain untouched.
    const first = await directApprove(finance2, entryId);
    expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(first.status).toBeLessThan(500);
    await expectNothingMoved(outletId, entryId, before);

    // The owner, who is only level 2, cannot skip level 1 either.
    const skip = await directApprove(ownerUser, entryId);
    expect(skip.status, JSON.stringify(skip.body)).toBeGreaterThanOrEqual(400);
    expect(skip.status).toBeLessThan(500);
    await expectNothingMoved(outletId, entryId, before);

    // After level 1 is approved in the inbox, level 2 is still open.
    await inboxDecide(finance2, (await openLevel(entryId)).id, "approved");
    const second = await directApprove(finance3, entryId);
    expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(second.status).toBeLessThan(500);
    await expectNothingMoved(outletId, entryId, before);
    expect((await requestsOf(entryId)).map((r) => r.status)).toEqual([
      "approved",
      "pending",
    ]);

    // The creator cannot use the direct route either.
    const own = await directApprove(creator, entryId);
    expect(own.status, JSON.stringify(own.body)).toBeGreaterThanOrEqual(400);
    await expectNothingMoved(outletId, entryId, before);
  });

  it("[so1036-petty-topup-SO-6-3] the creator, a person without the role, the wrong role and a repeat decider are refused; the chain stays open", async () => {
    await twoLevelMatrix();
    const before = await glSnapshot();
    const { outletId, entryId } = await submitHeld();

    await chainOf(entryId);
    // Level 1: creator (requester), nobody (no role), owner (level 2 role).
    for (const who of [creator, nobody, ownerUser])
      await expect(
        inboxDecide(who, (await openLevel(entryId)).id, "approved"),
      ).rejects.toThrow();
    expect((await requestsOf(entryId)).map((r) => r.status)).toEqual([
      "pending",
    ]);
    await expectNothingMoved(outletId, entryId, before);

    // Level 1 by a valid finance approver; then level 2: that same finance
    // user (already decided), another finance user (wrong role), the creator
    // and nobody are all refused. Only the owner may take level 2.
    await inboxDecide(finance2, (await openLevel(entryId)).id, "approved");
    for (const who of [finance2, finance3, creator, nobody])
      await expect(
        inboxDecide(who, (await openLevel(entryId)).id, "approved"),
      ).rejects.toThrow();
    expect((await requestsOf(entryId)).map((r) => r.status)).toEqual([
      "approved",
      "pending",
    ]);
    await expectNothingMoved(outletId, entryId, before);
  });

  it("[so1036-petty-topup-SO-6-4] after every level is approved the fund grows by the amount with exactly one balanced journal; replays and a race keep it at one", async () => {
    await twoLevelMatrix();
    const before = await glSnapshot();
    const { outletId, entryId } = await submitHeld();
    const chainId = await chainOf(entryId);

    await inboxDecide(finance2, (await openLevel(entryId)).id, "approved");
    // Level 1 alone settles nothing, even if a worker ran.
    await expectNothingMoved(outletId, entryId, before);

    await inboxDecide(ownerUser, (await openLevel(entryId)).id, "approved");
    // The decision alone does not move money; the consumer applies it.
    await expectNothingMoved(outletId, entryId, before);

    const event = await resolvedEvent(chainId);
    await Promise.all(
      [1, 2, 3].map(() =>
        handleCashBankApprovalResolved(tenantWide, event, new Date()),
      ),
    );
    await handleCashBankApprovalResolved(tenantWide, event, new Date());

    expect(await entryStatus(entryId)).toBe("approved");
    expect(await fundBalance(outletId)).toBe(AMOUNT);
    const journals = await topupJournals(outletId);
    expect(journals).toHaveLength(1);
    const { rows: lines } = await owner.query<{
      account_id: string;
      debit: string;
      credit: string;
    }>(
      `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
         FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
      [tenantId, journals[0]!.id],
    );
    const line = (accountId: string) =>
      lines.find((l) => l.account_id === accountId);
    expect(Number(line(world.gl.pettyCash)?.debit)).toBe(AMOUNT);
    expect(Number(line(world.gl.bankA)?.credit)).toBe(AMOUNT);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(
      lines.reduce((s, l) => s + Number(l.credit), 0),
    );
    expect(await glNet(world.gl.pettyCash)).toBe(before.petty + AMOUNT);
    expect(await glNet(world.gl.bankA)).toBe(before.bank - AMOUNT);
    expect((await requestsOf(entryId)).map((r) => r.status)).toEqual([
      "approved",
      "approved",
    ]);

    // A direct approve afterwards is idempotent: still one journal, one fund add.
    await directApprove(finance3, entryId);
    expect(await topupJournals(outletId)).toHaveLength(1);
    expect(await fundBalance(outletId)).toBe(AMOUNT);
  });

  it("[so1036-petty-topup-SO-6-5] a rejection moves nothing and the entry can no longer be approved directly", async () => {
    await twoLevelMatrix();
    const before = await glSnapshot();
    const { outletId, entryId } = await submitHeld();
    const chainId = await chainOf(entryId);

    await inboxDecide(finance2, (await openLevel(entryId)).id, "rejected");
    const event = await resolvedEvent(chainId);
    await handleCashBankApprovalResolved(tenantWide, event, new Date());

    expect(await entryStatus(entryId)).toBe("rejected");
    expect(await fundBalance(outletId)).toBeNull();
    expect(await topupJournals(outletId)).toHaveLength(0);

    for (const who of [finance3, ownerUser, creator]) {
      const res = await directApprove(who, entryId);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await entryStatus(entryId)).toBe("rejected");
    expect(await fundBalance(outletId)).toBeNull();
    expect(await topupJournals(outletId)).toHaveLength(0);
    expect(await glNet(world.gl.pettyCash)).toBe(before.petty);
    expect(await glNet(world.gl.bankA)).toBe(before.bank);
  });

  it("[so1036-petty-topup-SO-6-6] another tenant is blind: its worker scope applying the event changes nothing, and it sees no request", async () => {
    await twoLevelMatrix();
    const { outletId, entryId } = await submitHeld();
    const chainId = await chainOf(entryId);
    await inboxDecide(finance2, (await openLevel(entryId)).id, "approved");
    await inboxDecide(ownerUser, (await openLevel(entryId)).id, "approved");
    const event = await resolvedEvent(chainId);

    await handleCashBankApprovalResolved(foreignScope(), event, new Date());
    expect(await entryStatus(entryId)).toBe("pending_approval");
    expect(await fundBalance(outletId)).toBeNull();
    expect(await topupJournals(outletId)).toHaveLength(0);

    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM approval_requests WHERE tenant_id = $1 AND object_id = $2",
      [world.foreign.tenantId, entryId],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // Control: the owning tenant's scope applies it.
    await handleCashBankApprovalResolved(tenantWide, event, new Date());
    expect(await entryStatus(entryId)).toBe("approved");
    expect(await fundBalance(outletId)).toBe(AMOUNT);
    expect(await topupJournals(outletId)).toHaveLength(1);
  });

  it("[so1036-petty-topup-SO-6-7] with no cash_out policy the above-limit top-up is refused (fail closed): no pending entry, no fund, no journal", async () => {
    try {
      const { rows } = await owner.query<{ id: string }>(
        "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND action_type = $3 RETURNING id",
        [HELD_ACTION, tenantId, ACTION],
      );
      heldPolicyIds = rows.map((r) => r.id);
      // The default policy must exist, else this test proves nothing.
      expect(heldPolicyIds.length).toBeGreaterThan(0);

      const before = await glSnapshot();
      const outletId = await makeOutlet(world.entityId);
      const res = await move(creator, movementBody(outletId));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_POLICY_MISSING");
      expect(await topupEntryCount(outletId)).toBe(0);
      expect(await fundBalance(outletId)).toBeNull();
      expect(await topupJournals(outletId)).toHaveLength(0);
      expect(await glNet(world.gl.pettyCash)).toBe(before.petty);
    } finally {
      await cleanupPolicies();
    }
  });

  it("[so1036-petty-topup-SO-6-8] the same idempotency key on an above-limit top-up makes one entry and one chain", async () => {
    await twoLevelMatrix();
    const outletId = await makeOutlet(world.entityId);
    const body = movementBody(outletId);
    const first = await move(creator, body);
    const second = await move(creator, body);
    expect([200, 201, 202], JSON.stringify(first.body)).toContain(first.status);
    expect([200, 201, 202], JSON.stringify(second.body)).toContain(
      second.status,
    );
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await topupEntryCount(outletId)).toBe(1);
    await chainOf(first.body.data.id);
  });
});
