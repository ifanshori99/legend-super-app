// Payout batch list across runs (bead legend-396pf; brief
// docs/briefs/731-payout-api-gaps-impl.md C and T). Written fail-first from the
// brief and the shared contract (listPayoutBatchesQuerySchema,
// PayrollDisbursementBatchDto), not from the implementation.
//
// Route: GET /api/hris/payroll/payout-batches?legalEntityId=&status=&cursor=&limit=
// (permission payroll.view). Answers 200 { data: PayrollDisbursementBatchDto[],
// meta: { limit, nextCursor } }, newest first (created_at desc, id desc),
// keyset cursor, items of every batch included.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - limit is capped at 20 (round 2), so "one big page" means limit 20 (the file makes 5 batches).
// - The shared tenant also holds batches of other test files (other legal
//   entities), so listings are scoped with legalEntityId = this file's entity
//   unless a test is about the unfiltered view.
// - Expected status groups are read from the database after creation instead of
//   hard-coding what `createDisbursementBatch` starts as.
// - The "other legal entity" and "other tenant" batches are made by moving a
//   batch row (legal_entity_id / tenant_id) for the duration of a test; the
//   move is restored in `finally`.
// - A garbage cursor is a 4xx (400 or 422), never a 500 and never another
//   tenant's data; the exact status is not pinned.
// - Round 2 (T2): the cursor is opaque, so an impossible-date cursor is made
//   from a REAL cursor by replacing its date part with 2026-02-30 (the cursor is
//   read raw, or base64/base64url decoded when it has no date in the clear);
//   the answer must be 422, never a 500. limit is capped at 20 (default 20).
//   Tied created_at values are set through SQL with microsecond precision, to
//   prove the keyset never truncates the timestamp.
// - Invalid query: limit 0, limit not a number, unknown status, legalEntityId
//   not a uuid, an unknown query key (the schema is strict) are 422.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";
import { submitDisbursementBatch } from "../services/payroll-payout.service.ts";
import {
  BUDI,
  REQ,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("batch-list");
const LIST = "/api/hris/payroll/payout-batches";
const BATCH = "/api/hris/payroll/disbursement-batches";
const FOREIGN_TENANT_ID = "99999999-9999-4999-8999-999999999999";

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const extraEntities: string[] = [];
afterAll(async () => {
  if (extraEntities.length > 0)
    await W.asTenant(
      (c) =>
        c.query("DELETE FROM legal_entities WHERE id = ANY($1::uuid[])", [
          extraEntities,
        ]),
      true,
    );
  if (grantedUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  await dbOwner.end();
});

async function staff(permissions: string[]) {
  const client = agent(W.app);
  const email = await signUp(client, "Payout List");
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  if (permissions.length > 0) await W.grantRole(userId, permissions);
  return { client, userId };
}
type Staff = Awaited<ReturnType<typeof staff>>;

type BatchBody = {
  id: string;
  legalEntityId: string;
  status: string;
  createdAt: string;
  itemCount: number;
  items: { id: string; batchId: string }[];
};
type Page = {
  data: BatchBody[];
  meta: { limit: number; nextCursor: string | null };
};

async function listPage(
  who: Staff,
  query: Record<string, string | number | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const res = await who.client.get(`${LIST}?${params}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
}
/** Every page of a query, following nextCursor until it is null. */
async function listAll(
  who: Staff,
  query: Record<string, string | number | undefined>,
) {
  const rows: BatchBody[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await listPage(who, { ...query, cursor });
    rows.push(...page.data);
    if (page.meta.nextCursor === null) return rows;
    cursor = page.meta.nextCursor;
  }
  throw new Error("pagination never ended");
}

type Made = { id: string; status: string };
let made: Made[] | null = null;
/** Five batches of this file's legal entity: draft x2, pending, approved, exported. */
async function batches(): Promise<Made[]> {
  if (made) return made;
  const out: Made[] = [];
  const pending = async (runId: string) => {
    const id = await W.createBatch(runId);
    await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), id));
    return id;
  };
  const make = async (kind: "draft" | "pending" | "approved" | "exported") => {
    const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const id =
      kind === "draft"
        ? await W.createBatch(runId)
        : kind === "approved"
          ? await W.approvedBatch(runId)
          : kind === "exported"
            ? await W.exportedBatch(runId)
            : await pending(runId);
    out.push({ id, status: (await W.batchById(id)).status as string });
  };
  for (const kind of [
    "draft",
    "pending",
    "approved",
    "exported",
    "draft",
  ] as const)
    await make(kind);
  made = out;
  return out;
}
const mine = (
  who: Staff,
  extra: Record<string, string | number | undefined> = {},
) => listAll(who, { legalEntityId: W.entityId(), ...extra });

describe("legend-396pf payout batch list", () => {
  it("[396pf-list] lists the batches of the tenant newest first with their items, each equal to the batch detail", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const page = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 20,
    });
    expect(page.meta.limit).toBe(20);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.data.map((b) => b.id).sort()).toEqual(
      created.map((b) => b.id).sort(),
    );
    // Order: created_at desc, id desc.
    for (let i = 1; i < page.data.length; i++) {
      const prev = page.data[i - 1]!;
      const cur = page.data[i]!;
      const a = Date.parse(prev.createdAt);
      const b = Date.parse(cur.createdAt);
      expect(a >= b, "created_at never increases down the list").toBe(true);
      if (a === b) expect(prev.id > cur.id).toBe(true);
    }
    // Every entry carries its items and is the same body as the detail route.
    for (const entry of page.data) {
      expect(entry.items).toHaveLength(entry.itemCount);
      expect(entry.itemCount).toBeGreaterThan(0);
      for (const item of entry.items) expect(item.batchId).toBe(entry.id);
      const detail = await viewer.client.get(`${BATCH}/${entry.id}`);
      expect(detail.status).toBe(200);
      expect(entry).toEqual(detail.body.data);
    }
  });

  it("[396pf-pagination] cursor pages of 2 cover every batch once: no duplicate, none missing, same order as one big page", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const first = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 2,
    });
    expect(first.data).toHaveLength(2);
    expect(first.meta.limit).toBe(2);
    expect(first.meta.nextCursor).not.toBeNull();

    const paged = await mine(viewer, { limit: 2 });
    const ids = paged.map((b) => b.id);
    expect(new Set(ids).size, "no duplicate").toBe(ids.length);
    expect([...ids].sort()).toEqual(created.map((b) => b.id).sort());
    const single = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 20,
    });
    expect(ids).toEqual(single.data.map((b) => b.id));
    // The last page says there is no next one.
    const last = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: created.length,
    });
    expect(last.meta.nextCursor).toBeNull();
  });

  it("[396pf-status-filter] status narrows the list to that status, and every status of this entity is found", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const statuses = [...new Set(created.map((b) => b.status))];
    expect(
      statuses.length,
      "premise: more than one status exists",
    ).toBeGreaterThan(1);
    for (const status of statuses) {
      const rows = await mine(viewer, { status });
      expect(rows.map((b) => b.id).sort()).toEqual(
        created
          .filter((b) => b.status === status)
          .map((b) => b.id)
          .sort(),
      );
      for (const row of rows) expect(row.status).toBe(status);
    }
    expect(await mine(viewer, { status: "cancelled" })).toEqual([]);
  });

  it("[396pf-entity-filter] legalEntityId keeps only that entity; an entity without batches is an empty list, not an error", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const moved = created[created.length - 1]!;
    const otherEntity = randomUUID();
    extraEntities.push(otherEntity);
    await W.asTenant(
      (c) =>
        c.query(
          "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
          [otherEntity, W.tenantId, `PT List Lain ${otherEntity.slice(0, 6)}`],
        ),
      true,
    );
    const move = (to: string) =>
      W.asTenant(
        (c) =>
          c.query(
            "UPDATE payroll_disbursement_batches SET legal_entity_id = $2 WHERE id = $1",
            [moved.id, to],
          ),
        true,
      );
    await move(otherEntity);
    try {
      const elsewhere = await mine(viewer);
      expect(elsewhere.map((b) => b.id)).not.toContain(moved.id);
      expect(elsewhere).toHaveLength(created.length - 1);
      const other = await listAll(viewer, { legalEntityId: otherEntity });
      expect(other.map((b) => b.id)).toEqual([moved.id]);
      expect(other[0]!.legalEntityId).toBe(otherEntity);
    } finally {
      await move(W.entityId());
    }

    const none = await listPage(viewer, { legalEntityId: randomUUID() });
    expect(none.data).toEqual([]);
    expect(none.meta.nextCursor).toBeNull();
  });

  it("[396pf-tenant-isolation] a batch of another tenant is never listed, with or without filters, and a forged cursor is refused", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const foreign = created[0]!;
    const move = (to: string) =>
      W.asTenant(
        (c) =>
          c.query(
            "UPDATE payroll_disbursement_batches SET tenant_id = $2 WHERE id = $1",
            [foreign.id, to],
          ),
        true,
      );
    await move(FOREIGN_TENANT_ID);
    try {
      const scoped = await mine(viewer);
      expect(scoped.map((b) => b.id)).not.toContain(foreign.id);
      expect(scoped).toHaveLength(created.length - 1);
      const everything = await listAll(viewer, { limit: 20 });
      expect(everything.map((b) => b.id)).not.toContain(foreign.id);

      const forged = await viewer.client.get(
        `${LIST}?cursor=not-a-real-cursor`,
      );
      expect([400, 422], JSON.stringify(forged.body)).toContain(forged.status);
    } finally {
      await move(W.tenantId);
    }
    expect((await mine(viewer)).map((b) => b.id)).toContain(foreign.id);
  });

  it("[396pf-permission] without payroll.view 403, without a session 401; the batches stay private to staff who may see them", async () => {
    await batches();
    const nobody = await staff(["hr.employee.view"]);
    const denied = await nobody.client.get(LIST);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const anonymous = await agent(W.app).get(LIST);
    expect(anonymous.status).toBe(401);
    const allowed = await staff(["payroll.view"]);
    expect((await allowed.client.get(LIST)).status).toBe(200);
  });

  it("[396pf-invalid-query] limit 0, a non-numeric limit, an unknown status, a non-uuid entity and an unknown key are 422", async () => {
    await batches();
    const viewer = await staff(["payroll.view"]);
    for (const query of [
      "limit=0",
      "limit=abc",
      "status=bogus",
      "legalEntityId=not-a-uuid",
      "tenantId=99999999-9999-4999-8999-999999999999",
    ]) {
      const res = await viewer.client.get(`${LIST}?${query}`);
      expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(422);
    }
    // Control: the same route answers 200 for a valid query.
    expect((await viewer.client.get(`${LIST}?limit=1`)).status).toBe(200);
  });

  it("[396pf-limit-cap] limit 21 is 422, limit 20 is accepted, and the default limit is 20", async () => {
    await batches();
    const viewer = await staff(["payroll.view"]);
    const over = await viewer.client.get(`${LIST}?limit=21`);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    const max = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 20,
    });
    expect(max.meta.limit).toBe(20);
    const dflt = await listPage(viewer, { legalEntityId: W.entityId() });
    expect(dflt.meta.limit).toBe(20);
  });

  it("[396pf-cursor-impossible-date] a cursor whose date does not exist (2026-02-30, year 0000) is 422, not a 500", async () => {
    await batches();
    const viewer = await staff(["payroll.view"]);
    const first = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 1,
    });
    const real = first.meta.nextCursor;
    expect(real, "premise: there is a second page").not.toBeNull();
    const datePart = /\d{4}-\d{2}-\d{2}/;
    const forge = (cursor: string, date: string): string => {
      if (datePart.test(cursor)) return cursor.replace(datePart, date);
      for (const encoding of ["base64url", "base64"] as const) {
        const decoded = Buffer.from(cursor, encoding).toString("utf8");
        if (datePart.test(decoded))
          return Buffer.from(decoded.replace(datePart, date), "utf8").toString(
            encoding,
          );
      }
      throw new Error(`cursor format has no date to forge: ${cursor}`);
    };
    for (const date of ["2026-02-30", "0000-01-01"]) {
      const forged = forge(real!, date);
      expect(forged).not.toBe(real);
      const res = await viewer.client.get(
        `${LIST}?${new URLSearchParams({ cursor: forged, legalEntityId: W.entityId(), limit: "1" })}`,
      );
      expect(res.status, `${date}: ${JSON.stringify(res.body)}`).toBe(422);
    }
    // Control: the real cursor still works.
    const ok = await listPage(viewer, {
      legalEntityId: W.entityId(),
      limit: 1,
      cursor: real!,
    });
    expect(ok.data).toHaveLength(1);
  });

  it("[396pf-same-created-at] batches with the same created_at (and one a few microseconds apart) are listed once each across pages of 1 and 2, in the order of one big page", async () => {
    const created = await batches();
    const viewer = await staff(["payroll.view"]);
    const [x, y, z] = [created[0]!, created[1]!, created[2]!];
    const originals = await W.asTenant(
      (c) =>
        c.query(
          "SELECT id, created_at::text AS at FROM payroll_disbursement_batches WHERE id = ANY($1::uuid[])",
          [[x.id, y.id, z.id]],
        ),
      true,
    );
    const setAt = (id: string, at: string) =>
      W.asTenant(
        (c) =>
          c.query(
            "UPDATE payroll_disbursement_batches SET created_at = $2::timestamptz WHERE id = $1",
            [id, at],
          ),
        true,
      );
    try {
      // Newer than every other batch, so the ties sit at the top of the list.
      await setAt(x.id, "2031-01-01 00:00:00.123456+00");
      await setAt(y.id, "2031-01-01 00:00:00.123456+00");
      await setAt(z.id, "2031-01-01 00:00:00.123400+00");

      const single = await listPage(viewer, {
        legalEntityId: W.entityId(),
        limit: 20,
      });
      const expected = single.data.map((b) => b.id);
      expect(expected).toHaveLength(created.length);
      const [hi, lo] = [x.id, y.id].sort().reverse() as [string, string];
      expect(
        expected.slice(0, 3),
        "ties by id desc, then the earlier microsecond",
      ).toEqual([hi, lo, z.id]);

      for (const limit of [1, 2]) {
        const ids = (await mine(viewer, { limit })).map((b) => b.id);
        expect(new Set(ids).size, `limit ${limit}: no duplicate`).toBe(
          ids.length,
        );
        expect(ids, `limit ${limit}: none missing, same order`).toEqual(
          expected,
        );
      }
    } finally {
      for (const row of originals.rows as { id: string; at: string }[])
        await setAt(row.id, row.at);
    }
  });
});
