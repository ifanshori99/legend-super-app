// SO 1036 findings 1 and 5: cash out vs. the approval matrix (tier K money).
// Written from docs/qa/second-opinion-payout-kas-1036.md, docs/briefs/1037-ctx.md
// and packages/shared (approval policy semantics), not from the implementation.
// Real Express app, Better Auth, RLS and PostgreSQL on the disposable test DB.
//
// Rules under test:
// - legend-3bkvl (finding 1): while the approval chain of a cash out is open,
//   the direct endpoint POST /entries/:id/approve must NOT post a journal, at
//   any step (Finance step open, Owner step open). Only when EVERY chain step
//   is decided (Finance, then Owner) does exactly one journal exist.
// - legend-lhyt0 (finding 5): anti-split. Daily limit Rp5.000.000, matrix tier
//   from Rp5.000.000. Cash out Rp4.000.000 posts at once (below tier and
//   limit); a second Rp2.000.000 the same day makes a total of Rp6.000.000, so
//   it is held AND its approval chain is picked by the TOTAL (the two-step
//   Finance -> Owner tier), not by Rp2.000.000 (which matches no tier). It
//   cannot post before all steps are decided.
// - Another tenant stays isolated.
//
// Matrix used (one tier, two steps; requires_distinct_actor true as the table
// demands): threshold 5.000.000, level 1 = Finance, level 2 = Owner.
//
// Assumptions where the SO report is silent:
// - "rejected" for a premature direct approve = a 4xx answer that is not 401
//   or 422 (auth or validation noise); the exact code (403/409) is not pinned.
//   The entry stays `pending_approval`, no journal, bank GL does not move.
// - The inbox decision is made through `decideApprovalRequest` (as
//   cash-out-approval-inbox.test.ts) and the worker consumer
//   `handleCashBankApprovalResolved` applies the final outcome from the
//   `approval.resolved` event. Steps are decided in order; the next pending
//   request (lowest level) is the one decided. Whether the service creates
//   all step requests at once or one by one is not pinned.
// - The Owner holds `accounting.cash_bank.approve` (owner template = every
//   tenant permission), so an Owner direct approve is refused only because
//   the chain is still open, not for lack of permission.
// - Tenant isolation: the foreign tenant has no sessions in this harness, so
//   it is covered by (a) a foreign bank account refused, (b) the foreign
//   tenant's rows/requests/journals unchanged by this flow, (c) a session
//   with no role in the tenant cannot decide the pending entry.
// - The shared tenant's cash_out policy rows are swapped for the matrix for
//   the length of each test, under the EXCLUSIVE limit lock (same technique as
//   the missing-policy test in cash-out-approval-inbox.test.ts), and restored
//   in `finally` and in afterAll.
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
import { limitExclusiveLock } from "./helpers/cash-limit-lock.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const ACTION = "cash_out";
const HELD_ACTION = "cash_out_held_by_so1036";
const MIL = 1_000_000;
const TIER_FROM = 5 * MIL;

let world: World;
let outsider: Session;

const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  outsider = await withMfa(await signedIn(app, "SO36 outsider", []));
});

afterAll(async () => {
  await restorePolicies().catch(() => {});
  await closeKit();
});

// ---- policies --------------------------------------------------------------

let heldPolicyIds: string[] = [];
let matrixPolicyIds: string[] = [];

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  return rows[0].id;
}

async function restorePolicies() {
  if (matrixPolicyIds.length > 0) {
    await owner.query(
      "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND id = ANY($3::uuid[])",
      [`cash_out_so1036_done_${short()}`, tenantId, matrixPolicyIds],
    );
    matrixPolicyIds = [];
  }
  if (heldPolicyIds.length > 0) {
    await owner.query(
      "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND id = ANY($3::uuid[])",
      [ACTION, tenantId, heldPolicyIds],
    );
    heldPolicyIds = [];
  }
}

/** Runs `fn` with the two-step matrix (Finance, then Owner, from Rp5.000.000). */
async function withMatrix<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const held = await owner.query<{ id: string }>(
      "UPDATE approval_policies SET action_type = $1 WHERE tenant_id = $2 AND action_type = $3 RETURNING id",
      [HELD_ACTION, tenantId, ACTION],
    );
    heldPolicyIds = held.rows.map((r) => r.id);
    for (const [template, level] of [
      ["finance", 1],
      ["owner", 2],
    ] as const) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [tenantId, ACTION, TIER_FROM, await roleIdOf(template), level],
      );
      matrixPolicyIds.push(rows[0]!.id);
    }
    return await fn();
  } finally {
    await restorePolicies();
  }
}

// ---- sessions --------------------------------------------------------------

async function withMfa(session: Session): Promise<Session> {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [session.userId],
  );
  if (!rows[0]) throw new Error(`No user ${session.userId}`);
  await verifySessionMfa(rows[0].email);
  return session;
}
const user = async (label: string, role: "finance" | "owner") =>
  withMfa(await signedIn(app, `SO36 ${label}`, [{ role, outletId: null }]));

// ---- requests and reads ----------------------------------------------------

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

const cashOutBody = (
  amountIdr: number,
  extra: Record<string, unknown> = {},
) => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr,
  entryDate: daysAgo(1),
  description: "Bayar supplier SO1036",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

async function submit(who: Session, amountIdr: number) {
  const res = await post(who, cashOutBody(amountIdr));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; status: string; amountIdr: number };
}

type RequestRow = {
  id: string;
  chain_id: string;
  status: string;
  level: number;
  required_levels: number;
};
async function requestsOf(entryId: string): Promise<RequestRow[]> {
  const { rows } = await owner.query<RequestRow>(
    `SELECT id, chain_id, status, level, required_levels FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'cash_bank_entry' AND object_id = $2
      ORDER BY level, created_at`,
    [tenantId, entryId],
  );
  return rows;
}
/** The lowest-level request still waiting for a decision. */
async function nextPending(entryId: string): Promise<RequestRow> {
  const pending = (await requestsOf(entryId)).filter(
    (r) => r.status === "pending",
  );
  expect(pending.length, `pending requests of ${entryId}`).toBeGreaterThan(0);
  return pending[0]!;
}

async function entryRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    journal_entry_id: string | null;
  }>(
    "SELECT status, journal_entry_id FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  expect(rows, `entry ${id}`).toHaveLength(1);
  return rows[0]!;
}
const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);
async function bankNet(): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    "SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS net FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, world.gl.bankA],
  );
  return Number(rows[0]!.net);
}

async function inboxDecide(userId: string, requestId: string) {
  return decideApprovalRequest(
    tenantContext(),
    userId,
    requestId,
    { decision: "approved", reason: "Sesuai bukti pembayaran." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function resolvedEventOfChain(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows, "one approval.resolved event for the chain").toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The premature direct approve is refused and moves nothing. */
async function expectDirectApproveRefused(
  who: Session,
  entryId: string,
  label: string,
) {
  const netBefore = await bankNet();
  const res = await directApprove(who, entryId);
  expect(
    res.status >= 400 &&
      res.status < 500 &&
      res.status !== 401 &&
      res.status !== 422,
    `${label}: direct approve answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toBe(true);
  expect(await journalsOf(entryId), `${label}: journals`).toHaveLength(0);
  expect((await entryRow(entryId)).status, `${label}: entry status`).toBe(
    "pending_approval",
  );
  expect(await bankNet(), `${label}: bank GL`).toBe(netBefore);
}

/** Decides every open step in order (Finance, then Owner), then applies the outcome. */
async function decideAllSteps(
  entryId: string,
  finance2: Session,
  ownerUser: Session,
) {
  const first = await nextPending(entryId);
  await inboxDecide(finance2.userId, first.id);
  const second = await nextPending(entryId);
  expect(second.level).toBe(2);
  await inboxDecide(ownerUser.userId, second.id);
  const event = await resolvedEventOfChain(second.chain_id);
  await handleCashBankApprovalResolved(tenantWide, event, new Date());
  return event;
}

// ============================================================================

describe("SO1036 legend-3bkvl direct approve cannot bypass an open chain", () => {
  limitExclusiveLock();

  it("[so1036-cash-matrix-1] legend-3bkvl direct approve at tier 1 (Finance step open) is refused: no journal", async () => {
    await withMatrix(async () => {
      const creator = await user("m1 creator", "finance");
      const finance2 = await user("m1 finance", "finance");
      const entry = await submit(creator, 6 * MIL);
      expect(entry.status).toBe("pending_approval");
      const steps = await requestsOf(entry.id);
      expect(steps.length, "the chain exists").toBeGreaterThan(0);
      expect(Math.max(...steps.map((s) => s.required_levels))).toBe(2);

      await expectDirectApproveRefused(finance2, entry.id, "tier 1");
      // The chain is still open and decidable afterwards.
      expect((await nextPending(entry.id)).level).toBe(1);
    });
  });

  it("[so1036-cash-matrix-2] legend-3bkvl direct approve at tier 2 (Owner step open, Finance decided) is refused: no journal", async () => {
    await withMatrix(async () => {
      const creator = await user("m2 creator", "finance");
      const finance2 = await user("m2 finance", "finance");
      const ownerUser = await user("m2 owner", "owner");
      const entry = await submit(creator, 6 * MIL);
      expect(entry.status).toBe("pending_approval");

      await inboxDecide(finance2.userId, (await nextPending(entry.id)).id);
      expect((await nextPending(entry.id)).level).toBe(2);
      expect((await entryRow(entry.id)).status).toBe("pending_approval");
      expect(await journalsOf(entry.id)).toHaveLength(0);

      await expectDirectApproveRefused(ownerUser, entry.id, "tier 2 owner");
      await expectDirectApproveRefused(finance2, entry.id, "tier 2 finance");
    });
  });

  it("[so1036-cash-matrix-3] legend-3bkvl only after both steps (Finance, Owner) exactly one balanced journal exists", async () => {
    await withMatrix(async () => {
      const creator = await user("m3 creator", "finance");
      const finance2 = await user("m3 finance", "finance");
      const ownerUser = await user("m3 owner", "owner");
      const amountIdr = 6_200_000;
      const entry = await submit(creator, amountIdr);
      expect(entry.status).toBe("pending_approval");
      const netBefore = await bankNet();

      // Nothing before the last step is decided.
      await inboxDecide(finance2.userId, (await nextPending(entry.id)).id);
      expect(await journalsOf(entry.id)).toHaveLength(0);
      expect(await bankNet()).toBe(netBefore);

      const second = await nextPending(entry.id);
      await inboxDecide(ownerUser.userId, second.id);
      const event = await resolvedEventOfChain(second.chain_id);
      await Promise.all(
        [1, 2, 3].map(() =>
          handleCashBankApprovalResolved(tenantWide, event, new Date()),
        ),
      );

      const after = await entryRow(entry.id);
      expect(after.status).toBe("approved");
      const journals = await journalsOf(entry.id);
      expect(journals).toHaveLength(1);
      expect(after.journal_entry_id).toBe(journals[0]!.id);
      const lines = await journalLinesOf(journals[0]!.id);
      const debit = lines.reduce((sum, l) => sum + l.debit, 0);
      expect(debit).toBe(amountIdr);
      expect(lines.reduce((sum, l) => sum + l.credit, 0)).toBe(debit);
      expect(await bankNet()).toBe(netBefore - amountIdr);

      // A late direct approve stays idempotent: still one journal.
      await directApprove(finance2, entry.id);
      expect(await journalsOf(entry.id)).toHaveLength(1);
      expect(await bankNet()).toBe(netBefore - amountIdr);
    });
  });
});

describe("SO1036 legend-lhyt0 anti-split picks the matrix tier by the total", () => {
  limitExclusiveLock();

  it("[so1036-cash-matrix-4] legend-lhyt0 4jt then 2jt (limit 5jt, tier from 5jt): the second entry has a two-step chain and cannot post before all steps", async () => {
    await withMatrix(async () => {
      // One creator: the daily total adds up for this creator only.
      const creator = await user("m4 creator", "finance");
      const finance2 = await user("m4 finance", "finance");
      const ownerUser = await user("m4 owner", "owner");

      const first = await submit(creator, 4 * MIL);
      expect(first.status).toBe("approved");
      expect(await journalsOf(first.id)).toHaveLength(1);
      expect(await requestsOf(first.id)).toHaveLength(0);

      const netBefore = await bankNet();
      const second = await submit(creator, 2 * MIL);
      // Total 6jt > 5jt limit: held.
      expect(second.status).toBe("pending_approval");
      // The chain exists and was picked by the TOTAL (6jt -> two steps), not
      // by 2jt (which matches no tier and gave no chain at all).
      const steps = await requestsOf(second.id);
      expect(steps.length, "pending entry must have a chain").toBeGreaterThan(
        0,
      );
      expect(Math.max(...steps.map((s) => s.required_levels))).toBe(2);
      expect(await journalsOf(second.id)).toHaveLength(0);

      // No shortcut: direct approve at each step is refused.
      await expectDirectApproveRefused(finance2, second.id, "split step 1");
      await inboxDecide(finance2.userId, (await nextPending(second.id)).id);
      await expectDirectApproveRefused(ownerUser, second.id, "split step 2");
      expect(await bankNet()).toBe(netBefore);

      // After the last step: exactly one journal for the 2jt entry.
      const last = await nextPending(second.id);
      expect(last.level).toBe(2);
      await inboxDecide(ownerUser.userId, last.id);
      const event = await resolvedEventOfChain(last.chain_id);
      await handleCashBankApprovalResolved(tenantWide, event, new Date());
      expect((await entryRow(second.id)).status).toBe("approved");
      expect(await journalsOf(second.id)).toHaveLength(1);
      expect(await bankNet()).toBe(netBefore - 2 * MIL);
    });
  });
});

describe("SO1036 tenant isolation of the matrix flow", () => {
  limitExclusiveLock();

  it("[so1036-cash-matrix-5] another tenant is untouched and an outsider cannot decide the pending entry", async () => {
    await withMatrix(async () => {
      const foreignCounts = async () => {
        const { rows } = await owner.query<{ name: string; n: string }>(
          `SELECT 'entries' AS name, count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1
           UNION ALL SELECT 'requests', count(*)::text FROM approval_requests WHERE tenant_id = $1
           UNION ALL SELECT 'journals', count(*)::text FROM journal_entries WHERE tenant_id = $1
           UNION ALL SELECT 'policies', count(*)::text FROM approval_policies WHERE tenant_id = $1 AND action_type = 'cash_out'`,
          [world.foreign.tenantId],
        );
        return Object.fromEntries(rows.map((r) => [r.name, r.n]));
      };
      const foreignBefore = await foreignCounts();

      const creator = await user("m5 creator", "finance");
      const finance2 = await user("m5 finance", "finance");
      const ownerUser = await user("m5 owner", "owner");

      // A foreign bank account is invisible: refused, nothing written.
      const foreignTry = await post(
        creator,
        cashOutBody(6 * MIL, { bankAccountId: world.foreign.bankAccountId }),
      );
      expect([403, 404], JSON.stringify(foreignTry.body)).toContain(
        foreignTry.status,
      );

      const entry = await submit(creator, 6 * MIL);
      expect(entry.status).toBe("pending_approval");

      // Someone with no role in this tenant cannot approve it directly or in the inbox.
      const res = await directApprove(outsider, entry.id);
      expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
      await expect(
        inboxDecide(outsider.userId, (await nextPending(entry.id)).id),
      ).rejects.toBeDefined();
      expect(await journalsOf(entry.id)).toHaveLength(0);
      expect((await entryRow(entry.id)).status).toBe("pending_approval");

      // The legitimate chain still completes with exactly one journal.
      await decideAllSteps(entry.id, finance2, ownerUser);
      expect(await journalsOf(entry.id)).toHaveLength(1);

      expect(await foreignCounts()).toEqual(foreignBefore);
    });
  });
});
