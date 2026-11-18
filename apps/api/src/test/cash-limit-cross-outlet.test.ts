// Anti-split across outlets (founder Q18, tier K money). Written from the brief
// (brief-649) and the black-box API, not from the implementation. Real Better
// Auth, RLS and PostgreSQL on the disposable test DB; requests go through
// createApp().
//
// Rule under test (supersedes the per-outlet grouping of
// accounting-cash-limit-antisplit.test.ts AS-6b/AS-5g): for one creator, one
// tenant and one calendar day, over ALL outlets and entries without an outlet,
// the amount of THIS entry + earlier cash outs + petty top-ups (approved or
// pending, never rejected) > the tenant limit (Rp5.000.000, strict) makes THIS
// entry `pending_approval` with no journal. Earlier entries never change.
//
// Fail-first mapping:
//   CLX-1 two outlets, same creator, same day     CLX-2 entry without outlet
//   CLX-3 other creator not summed                 CLX-4 other day not summed
//   CLX-5 other tenant not summed                  CLX-6 petty top-up counted
//   CLX-7 parallel submits on two outlets          CLX-8 rejected not counted
//   CLX-9 exactly the limit posts, one rupiah more is pending
//   CLX-10 creator whose outlet scope narrowed to B still has the A top-up summed
//   CLX-11 migration 0341 function ignores other tenants (tenant from the GUC)
//   CLX-12 migration 0341 function skips `pt/...` ledger rows, keeps direct top-ups
//
// Isolation: the Cafe Legend tenant is shared with other test files. Every
// test uses its OWN creator (fresh sign-up) and fresh outlets, so the
// per-creator daily total never leaks between tests. The limit is shared
// state: the shared limit lock keeps it at the default Rp5.000.000. This file
// never changes the limit.
//
// Assumptions where the brief is silent:
// - A cash out answers 201 with data.status approved | pending_approval; a
//   petty top-up answers 201 (direct) or 202 (pending, kind petty_topup), as
//   in accounting-cash-limit-antisplit.test.ts.
// - "Calendar day" is judged on the server created_at. The day tests move
//   created_at of an earlier row by 36 hours, which is another calendar day in
//   any time zone. A run that straddles the tenant's midnight can in theory
//   split two same-day entries; accepted as negligible.
// - CLX-10: the creator first holds a tenant-wide finance grant, then that
//   grant is replaced (owner SQL) by a finance grant on outlet B only, same user
//   id. An outlet-scoped finance user cannot post cash out (CB-22), so no cash out is posted; only the function result is asserted. Brief says RLS hides the outlet-A
//   petty_cash_entries; the test also proves that premise directly as the
//   runtime login with app.outlet_ids = [B].
// - CLX-11/12 call app.cash_limit_direct_topups(actor, since) as legend_app
//   (rolled back); outlet scope is '*' there, the tenant GUC is overridden.
//   CLX-12 makes the `pt/...` row the real way: a pending top-up approved by a
//   second finance user.
// - Foreign-tenant rows are inserted as the migration owner (copy of a real
//   row, ids moved over), created_by = the same user id, entity level
//   (no outlet) and status pending_approval (counts when summed wrongly).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { originHeader } from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  journalsByKey,
  key,
  makeOutlet,
  asRuntime,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import { approveChainLevelAs } from "./helpers/cash-out-chain.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const MIL = 1_000_000;

let world: World;
const foreignEntryIds: string[] = [];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
});

afterAll(async () => {
  // Owner cleanup of the foreign-tenant rows of CLX-5 (replica skips FKs).
  if (foreignEntryIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM cash_bank_entries WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [world.foreign.tenantId, foreignEntryIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  await closeKit();
});

// Keeps the shared tenant limit at its default while each test runs.
withLimitSharedLock();

// ---- sessions, requests ----------------------------------------------------

const finance = (label: string) =>
  signedIn(app, `CLX ${label}`, [{ role: "finance", outletId: null }]);
const freshOutlet = () => makeOutlet(world.entityId);

type Json = Record<string, unknown>;
const postEntry = (who: Session, body: Json) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const postMove = (who: Session, body: Json) =>
  who.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send(body as object);
const decide = (
  who: Session,
  entryId: string,
  action: "approve" | "reject",
  body: Json = {},
) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/${action}`)
    .set(originHeader)
    .send(body);
const reject = (who: Session, id: string) =>
  decide(who, id, "reject", { reason: "Tidak sesuai" });

const cashOut = (who: Session, outletId: string | null, amountIdr: number) =>
  postEntry(who, {
    kind: "cash_out",
    legalEntityId: world.entityId,
    bankAccountId: world.bankAccountA,
    counterAccountId: world.gl.expense,
    amountIdr,
    entryDate: daysAgo(1),
    description: "Bayar supplier",
    reference: `REF-${short()}`,
    idempotencyKey: key(),
    ...(outletId ? { outletId } : {}),
  });
const topup = (who: Session, outletId: string, amountIdr: number) =>
  postMove(who, {
    kind: "topup",
    outletId,
    bankAccountId: world.bankAccountA,
    amountIdr,
    description: "Isi kas kecil",
    idempotencyKey: key(),
  });

type Res = Pick<Response, "status" | "body">;
type Outcome = "direct" | "pending";

function coOutcome(res: Res): Outcome {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const status = res.body.data.status as string;
  expect(["approved", "pending_approval"], JSON.stringify(res.body)).toContain(
    status,
  );
  return status === "approved" ? "direct" : "pending";
}
function tuOutcome(res: Res): Outcome {
  expect([201, 202], JSON.stringify(res.body)).toContain(res.status);
  return res.status === 202 ? "pending" : "direct";
}

const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);

/** Moves the SERVER created_at of one cash_bank_entries row (owner, no triggers). */
async function backdate(entryId: string, instant: Date): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const res = await client.query(
      "UPDATE cash_bank_entries SET created_at = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, entryId, instant.toISOString()],
    );
    expect(res.rowCount).toBe(1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================

describe("anti-split across outlets: same creator, same day", () => {
  it("[cash-limit-cross-outlet-CLX-1] Rp3 jt at outlet A then Rp3 jt at outlet B: the second is pending with no journal; the first stays approved", async () => {
    const creator = await finance("clx1");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    const first = await cashOut(creator, outletA, 3 * MIL);
    expect(coOutcome(first)).toBe("direct");
    const second = await cashOut(creator, outletB, 3 * MIL);
    expect(coOutcome(second)).toBe("pending");
    expect(second.body.data.journalEntryId ?? null).toBeNull();
    expect(await journalsOf(second.body.data.id)).toHaveLength(0);
    // Earlier entry is untouched: still approved, still one journal.
    expect(await journalsOf(first.body.data.id)).toHaveLength(1);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.body.data.id],
    );
    expect(rows[0]!.status).toBe("approved");
  });

  it("[cash-limit-cross-outlet-CLX-2] an entry without outlet counts with outlet entries, in both orders", async () => {
    // No outlet first, then outlet A.
    const one = await finance("clx2 one");
    const outletA = await freshOutlet();
    expect(coOutcome(await cashOut(one, null, 3 * MIL))).toBe("direct");
    const second = await cashOut(one, outletA, 3 * MIL);
    expect(coOutcome(second)).toBe("pending");
    expect(await journalsOf(second.body.data.id)).toHaveLength(0);

    // Outlet A first, then no outlet.
    const two = await finance("clx2 two");
    const outletB = await freshOutlet();
    expect(coOutcome(await cashOut(two, outletB, 3 * MIL))).toBe("direct");
    const other = await cashOut(two, null, 3 * MIL);
    expect(coOutcome(other)).toBe("pending");
    expect(await journalsOf(other.body.data.id)).toHaveLength(0);
  });

  it("[cash-limit-cross-outlet-CLX-9] a total exactly at the limit posts across outlets; one more rupiah is pending", async () => {
    const creator = await finance("clx9");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    const outletC = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outletA, 3 * MIL))).toBe("direct");
    // 3 + 2 = 5 jt = limit: strict `>` means it is NOT gated.
    expect(coOutcome(await cashOut(creator, outletB, 2 * MIL))).toBe("direct");
    // Total would be 5.000.001: gated, on a third outlet.
    expect(coOutcome(await cashOut(creator, outletC, 1))).toBe("pending");
  });
});

describe("anti-split across outlets: what is not summed", () => {
  it("[cash-limit-cross-outlet-CLX-3] another creator is not summed, even across outlets", async () => {
    const one = await finance("clx3 one");
    const two = await finance("clx3 two");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    expect(coOutcome(await cashOut(one, outletA, 3 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(two, outletB, 3 * MIL))).toBe("direct");
    // Control: the same creator on another outlet is summed.
    const outletC = await freshOutlet();
    expect(coOutcome(await cashOut(one, outletC, 3 * MIL))).toBe("pending");
  });

  it("[cash-limit-cross-outlet-CLX-4] an entry of an earlier calendar day is not summed", async () => {
    const creator = await finance("clx4");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    const yesterday = await cashOut(creator, outletA, 4 * MIL);
    expect(coOutcome(yesterday)).toBe("direct");
    // 36 hours ago is another calendar day in any time zone.
    await backdate(
      yesterday.body.data.id as string,
      new Date(Date.now() - 36 * 3600_000),
    );
    expect(coOutcome(await cashOut(creator, outletB, 4 * MIL))).toBe("direct");
    // Control: today's 4 jt at outlet B is counted at outlet A.
    expect(coOutcome(await cashOut(creator, outletA, 2 * MIL))).toBe("pending");
  });

  it("[cash-limit-cross-outlet-CLX-5] another tenant's entries of the same user id are not summed", async () => {
    const creator = await finance("clx5");
    const donor = await finance("clx5 donor");
    const outletA = await freshOutlet();

    // A real row of the donor, copied into the foreign tenant as pending
    // 4 jt created by `creator`. Summed wrongly it would push 3 jt over 5 jt.
    const seed = await cashOut(donor, null, 4 * MIL);
    expect(coOutcome(seed)).toBe("direct");
    const source = await owner.query<{ doc: Json }>(
      "SELECT to_jsonb(e) AS doc FROM cash_bank_entries e WHERE tenant_id = $1 AND id = $2",
      [tenantId, seed.body.data.id],
    );
    const foreignGl = await owner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY code LIMIT 1",
      [world.foreign.tenantId, world.foreign.entityId],
    );
    const foreignId = randomUUID();
    foreignEntryIds.push(foreignId);
    await owner.query(
      "INSERT INTO cash_bank_entries SELECT (json_populate_record(NULL::cash_bank_entries, $1::json)).*",
      [
        JSON.stringify({
          ...source.rows[0]!.doc,
          id: foreignId,
          tenant_id: world.foreign.tenantId,
          legal_entity_id: world.foreign.entityId,
          bank_account_id: world.foreign.bankAccountId,
          counter_account_id: foreignGl.rows[0]!.id,
          outlet_id: null,
          created_by: creator.userId,
          idempotency_key: key(),
          journal_entry_id: null,
          status: "pending_approval",
          approver_id: null,
          decided_at: null,
          decision_reason: null,
        }),
      ],
    );
    expect(coOutcome(await cashOut(creator, outletA, 3 * MIL))).toBe("direct");
    // Control: this tenant's own entries are summed.
    const outletB = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outletB, 3 * MIL))).toBe("pending");
  });
});

describe("anti-split across outlets: petty cash top-up and rejection", () => {
  it("[cash-limit-cross-outlet-CLX-6] a petty top-up at outlet A counts with a cash out at outlet B, in both orders", async () => {
    const one = await finance("clx6 one");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    expect(tuOutcome(await topup(one, outletA, 3 * MIL))).toBe("direct");
    const out = await cashOut(one, outletB, 3 * MIL);
    expect(coOutcome(out)).toBe("pending");
    expect(await journalsOf(out.body.data.id)).toHaveLength(0);

    // Cash out first, then the top-up at another outlet is pending (202).
    const two = await finance("clx6 two");
    const outletC = await freshOutlet();
    const outletD = await freshOutlet();
    expect(coOutcome(await cashOut(two, outletC, 3 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(two, outletD, 3 * MIL))).toBe("pending");
  });

  it("[cash-limit-cross-outlet-CLX-8] a rejected entry is not counted across outlets; a pending one is", async () => {
    const approver = await finance("clx8 approver");

    // Rejected: 3 jt posts, 3 jt is pending then rejected, so a 2 jt entry
    // at a third outlet makes 3 + 2 = 5 jt = limit and posts.
    const creator = await finance("clx8 creator");
    const [a, b, c] = [
      await freshOutlet(),
      await freshOutlet(),
      await freshOutlet(),
    ];
    expect(coOutcome(await cashOut(creator, a, 3 * MIL))).toBe("direct");
    const gated = await cashOut(creator, b, 3 * MIL);
    expect(coOutcome(gated)).toBe("pending");
    const res = await reject(approver, gated.body.data.id as string);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(coOutcome(await cashOut(creator, c, 2 * MIL))).toBe("direct");

    // Control: the same sequence without the reject. The pending 3 jt
    // counts, so the 2 jt entry is pending.
    const other = await finance("clx8 other");
    const [d, e, f] = [
      await freshOutlet(),
      await freshOutlet(),
      await freshOutlet(),
    ];
    expect(coOutcome(await cashOut(other, d, 3 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(other, e, 3 * MIL))).toBe("pending");
    expect(coOutcome(await cashOut(other, f, 2 * MIL))).toBe("pending");
  });
});

describe("anti-split across outlets: parallel submits", () => {
  it("[cash-limit-cross-outlet-CLX-7] two parallel Rp3 jt submits at outlets A and B: exactly one posts, one is pending; repeated 3 times", async () => {
    for (let round = 0; round < 3; round += 1) {
      const creator = await finance(`clx7 ${round}`);
      const outletA = await freshOutlet();
      const outletB = await freshOutlet();
      const results = await Promise.all([
        cashOut(creator, outletA, 3 * MIL),
        cashOut(creator, outletB, 3 * MIL),
      ]);
      const outcomes = results.map(coOutcome);
      expect(
        outcomes.filter((o) => o === "direct"),
        `round ${round}: ${outcomes}`,
      ).toHaveLength(1);
      expect(outcomes.filter((o) => o === "pending")).toHaveLength(1);
      for (const res of results) {
        expect(await journalsOf(res.body.data.id)).toHaveLength(
          res.body.data.status === "approved" ? 1 : 0,
        );
      }
    }
  });
});

// ---- migration 0341: app.cash_limit_direct_topups --------------------------

type TopupRow = { amount_idr: string; created_at: Date };

/** Calls the 0341 function as legend_app; `tenant`/`outletScope` override the GUCs. */
const directTopups = (
  actor: string,
  opts: { tenant?: string; outletScope?: string[] } = {},
): Promise<TopupRow[]> =>
  asRuntime(async (client: PoolClient) => {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [
        opts.tenant ?? tenantId,
        opts.outletScope ? JSON.stringify(opts.outletScope) : "*",
      ],
    );
    const { rows } = await client.query<TopupRow>(
      "SELECT amount_idr, created_at FROM app.cash_limit_direct_topups($1, $2)",
      [actor, new Date(Date.now() - 48 * 3600_000).toISOString()],
    );
    return rows;
  });

/** Replaces all grants of the user by one finance grant on a single outlet (owner). */
async function narrowToOutlet(userId: string, outletId: string) {
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, role.rows[0]!.id, outletId],
  );
}

describe("anti-split across outlets: hidden top-ups (migration 0341)", () => {
  it("[cash-limit-cross-outlet-CLX-10] outlet scope narrowed to B: the direct Rp3 jt top-up at outlet A is still reported to the narrowed outlet scope [B] although RLS hides it", async () => {
    const creator = await finance("clx10");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    expect(tuOutcome(await topup(creator, outletA, 3 * MIL))).toBe("direct");

    await narrowToOutlet(creator.userId, outletB);

    // Premise: with scope [B] the outlet-RLS table hides the outlet-A top-up,
    // but the narrow function still reports it.
    const hidden = await asRuntime(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenantId, JSON.stringify([outletB])],
      );
      const { rows } = await client.query(
        "SELECT 1 FROM petty_cash_entries WHERE tenant_id = $1 AND created_by = $2 AND kind = 'topup'",
        [tenantId, creator.userId],
      );
      return rows.length;
    });
    expect(hidden).toBe(0);
    const seen = await directTopups(creator.userId, { outletScope: [outletB] });
    expect(seen.map((row) => Number(row.amount_idr))).toEqual([3 * MIL]);

    // Contract (legend-4961-CB-22): an outlet-scoped finance user cannot record
    // cash out at all (403 OUTLET_OUT_OF_SCOPE), so the narrowed creator cannot
    // post the Rp3 jt cash out through the API. The anti-split sum a cash out
    // would use is exactly what the function reported above.
  });

  it("[cash-limit-cross-outlet-CLX-11] another tenant's app.tenant_id returns no rows for the same actor", async () => {
    const creator = await finance("clx11");
    const outletA = await freshOutlet();
    expect(tuOutcome(await topup(creator, outletA, 3 * MIL))).toBe("direct");

    // Control: the creator's own tenant returns the top-up.
    const own = await directTopups(creator.userId);
    expect(own.map((row) => Number(row.amount_idr))).toEqual([3 * MIL]);
    // Another tenant (same user id as actor) sees nothing.
    const foreign = await directTopups(creator.userId, {
      tenant: world.foreign.tenantId,
    });
    expect(foreign).toHaveLength(0);
  });

  it("[cash-limit-cross-outlet-CLX-12] a `pt/...` ledger row of an approved top-up is not returned; the direct top-up is", async () => {
    const creator = await finance("clx12 creator");
    const approver = await finance("clx12 approver");
    const outletA = await freshOutlet();
    const outletB = await freshOutlet();
    expect(tuOutcome(await topup(creator, outletA, 3 * MIL))).toBe("direct");
    // 3 + 3 jt over the limit: pending (202), then approved by another user,
    // which writes the ledger row with key `pt/<entryId>`.
    const pending = await topup(creator, outletB, 3 * MIL);
    expect(tuOutcome(pending)).toBe("pending");
    const pendingId = pending.body.data.id as string;
    await approveChainLevelAs(approver, pendingId);
    const approved = await decide(approver, pendingId, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    // Premise: the pt/ ledger row exists for outlet B.
    const ledger = await owner.query(
      "SELECT 1 FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2 AND kind = 'topup' AND idempotency_key LIKE 'pt/%'",
      [tenantId, outletB],
    );
    expect(ledger.rowCount).toBeGreaterThanOrEqual(1);

    // Only the direct top-up (outlet A) is returned, whoever owns the pt/ row.
    const forCreator = await directTopups(creator.userId);
    const forApprover = await directTopups(approver.userId);
    expect(forCreator.map((row) => Number(row.amount_idr))).toEqual([3 * MIL]);
    expect(forApprover).toHaveLength(0);
  });
});
