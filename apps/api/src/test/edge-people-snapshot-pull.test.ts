// Edge people snapshot, pull side (bead legend-tkycp card C3; design
// docs/design/hris-edge-replication.md 3.1 and 9 T2). `pullPeopleSnapshotOnce`
// runs against a second database that plays the edge (test/helpers/edge-database.ts)
// with an injected `fetch` that plays the cloud. Written from the design and
// the shared contract, not from the implementation.
//
// Assumptions (spec ambiguities):
//  - The result of a pull is `{ status: "applied" | "unchanged" }`; the tests
//    only rely on the stored state, plus `status` where the brief names it.
//  - Errors carry a `code`: `BAD_SNAPSHOT` for a body that fails the snapshot
//    schema, `BAD_RESPONSE` for a 200 without an ETag, `CLOUD_HTTP_<status>`
//    for a cloud error.
//  - The cloud link URL is `ws://.../api/edge-link`; the fetch sees
//    `http://<host>/api/edge-sync/people-snapshot`.
//  - One case builds the snapshot with the cloud's `buildEdgePeopleSnapshot`
//    on the main test database (outlet O cloned there too); the others use
//    hand-built objects that pass `edgePeopleSnapshotSchema`.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER,
  EDGE_PEOPLE_SNAPSHOT_PATH,
  edgePeopleSnapshotSchema,
} from "@starter/shared/edge/people-snapshot";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { pullPeopleSnapshotOnce } from "../edge/people-snapshot-pull.ts";
import { buildEdgePeopleSnapshot } from "../services/edge-people-snapshot.ts";
import type { VerifiedEdgeNode } from "../services/staff-pin-sync.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  edgeClaims,
  peopleBuilders,
  qrKey,
  type EdgeDatabase,
  type Row,
} from "./helpers/edge-database.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const CLOUD_URL = "ws://cloud.test/api/edge-link";
const T1 = new Date("2026-11-10T03:00:00.000Z");
const T2 = new Date("2026-11-10T03:05:00.000Z");
const GENERATED_AT = "2026-11-10T02:59:00.000Z";

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let outletId = "";
let edge: EdgeDatabase;
let credential = "";
let build: ReturnType<typeof peopleBuilders>;
const createdUsers: string[] = [];

beforeAll(async () => {
  outletId = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji tarik snapshot",
  );
  edge = await createEdgeDatabase({ tenantId, outletId });
  credential = edgeClaims(tenantId, outletId).credential;
  build = peopleBuilders({ tenantId, outletId });
}, 240_000);

afterAll(async () => {
  await edge?.cleanup();
  try {
    await mainOwner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND home_outlet_id = $2",
      [tenantId, outletId],
    );
    await mainOwner.query(
      "DELETE FROM attendance_qr_secrets WHERE outlet_id = $1",
      [outletId],
    );
    await mainOwner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      createdUsers,
    ]);
    await mainOwner.query("DELETE FROM outlets WHERE id = $1", [outletId]);
  } catch {
    // Best effort: a private outlet no other file reads.
  }
  await mainOwner.end();
});

beforeEach(async () => {
  await edge.resetPeople();
});

// ---- the cloud, as a fetch --------------------------------------------------

type Seen = {
  url: string;
  ifNoneMatch: string | null;
  authorization: string | null;
};

function cloudThatAnswers(respond: (seen: Seen) => Response): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const entry: Seen = {
      url: String(input),
      ifNoneMatch: headers.get("If-None-Match"),
      authorization: headers.get("Authorization"),
    };
    seen.push(entry);
    return respond(entry);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const snapshotResponse = (body: unknown, etag: string | null = '"etag-1"') =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...(etag === null ? {} : { ETag: etag }),
      [EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER]: GENERATED_AT,
    },
  });
const notModified = () => new Response(null, { status: 304 });

const pull = (fetchImpl: typeof fetch, now: Date = T1) =>
  pullPeopleSnapshotOnce(
    { cloudUrl: CLOUD_URL, credential },
    { fetchImpl, database: edge.database, now },
  );

// ---- reads on the edge database ---------------------------------------------

const userIds = async () =>
  (await edge.rows(`SELECT id FROM "user" ORDER BY id`)).map(
    (row) => row.id as string,
  );
const syncState = async () =>
  (
    await edge.rows(
      `SELECT snapshot_etag, snapshot_generated_at, applied_at, last_checked_at
         FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenantId, outletId],
    )
  )[0];
async function dump() {
  const out: Record<string, Row[]> = {};
  for (const [name, text] of Object.entries({
    users: `SELECT to_jsonb(t) AS r FROM "user" t ORDER BY id`,
    employees: `SELECT to_jsonb(t) AS r FROM employees t ORDER BY id`,
    qrKeys: `SELECT to_jsonb(t) - 'received_at' AS r FROM edge_attendance_qr_keys t ORDER BY day_index`,
  }))
    out[name] = (await edge.rows(text)).map((row) => row.r as Row);
  return out;
}

const person = () => {
  const user = build.user();
  return { user, employee: build.employee(user.id as string) };
};

describe("legend-tkycp the edge pulls the people snapshot", () => {
  it("accepts and drops future fields on the envelope and QR keys", async () => {
    const a = person();
    const key = qrKey(20_400);
    const clean = build.snapshot({
      users: [a.user],
      employees: [a.employee],
      qrKeys: [key],
    });
    const future = {
      ...clean,
      futureField: "future-envelope-value",
      qrKeys: [{ ...key, futureField: "future-qr-value" }],
    };

    expect(edgePeopleSnapshotSchema.parse(future)).toEqual(clean);
    expect(
      await pull(
        cloudThatAnswers(() => snapshotResponse(future)).fetchImpl,
        T1,
      ),
    ).toMatchObject({ status: "applied" });
    expect(await userIds()).toEqual([a.user.id]);
    const stored = await dump();
    expect(stored.qrKeys).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("future-envelope-value");
    expect(JSON.stringify(stored)).not.toContain("future-qr-value");
  });

  it("first pull sends no If-None-Match and applies; the next one sends the stored ETag and a 304 moves only last_checked_at", async () => {
    const a = person();
    const body = build.snapshot({
      users: [a.user],
      employees: [a.employee],
      qrKeys: [qrKey(20_400)],
    });

    const first = cloudThatAnswers(() => snapshotResponse(body));
    expect(await pull(first.fetchImpl, T1)).toMatchObject({
      status: "applied",
    });
    expect(first.seen).toHaveLength(1);
    expect(first.seen[0]!.url).toBe(
      `http://cloud.test${EDGE_PEOPLE_SNAPSHOT_PATH}`,
    );
    expect(first.seen[0]!.ifNoneMatch).toBeNull();
    expect(first.seen[0]!.authorization).toBe(`Bearer ${credential}`);
    expect(await userIds()).toEqual([a.user.id]);
    const applied = await syncState();
    expect(applied).toMatchObject({ snapshot_etag: '"etag-1"' });
    expect(applied!.applied_at).toEqual(T1);
    expect(applied!.snapshot_generated_at).toEqual(new Date(GENERATED_AT));
    const before = await dump();

    const second = cloudThatAnswers(() => notModified());
    expect(await pull(second.fetchImpl, T2)).toMatchObject({
      status: "unchanged",
    });
    expect(second.seen.map((entry) => entry.ifNoneMatch)).toEqual(['"etag-1"']);
    const after = await syncState();
    expect(after!.last_checked_at).toEqual(T2);
    expect({ ...after, last_checked_at: null }).toEqual({
      ...applied,
      last_checked_at: null,
    });
    expect(await dump()).toEqual(before);
  });

  it("a changed snapshot replaces the stored ETag and the data", async () => {
    const a = person();
    const b = person();
    await pull(
      cloudThatAnswers(() =>
        snapshotResponse(
          build.snapshot({ users: [a.user], employees: [a.employee] }),
        ),
      ).fetchImpl,
      T1,
    );

    const second = cloudThatAnswers(() =>
      snapshotResponse(
        build.snapshot({ users: [b.user], employees: [b.employee] }),
        '"etag-2"',
      ),
    );
    await pull(second.fetchImpl, T2);

    expect(second.seen[0]!.ifNoneMatch).toBe('"etag-1"');
    expect((await syncState())!.snapshot_etag).toBe('"etag-2"');
    const rows = await edge.rows(`SELECT id, banned FROM "user"`);
    expect(rows.find((row) => row.id === a.user.id)?.banned).toBe(true);
    expect(rows.find((row) => row.id === b.user.id)?.banned).toBe(false);
  });

  it("an invalid snapshot is not applied, not even in part, and the stored state stays", async () => {
    // Nothing stored yet: a valid user next to an employee that is not an
    // allowed status must leave an empty database.
    const a = person();
    const invalid = build.rawSnapshot({
      users: [a.user],
      employees: [{ ...a.employee, status: "terminated" }],
    });
    await expect(
      pull(cloudThatAnswers(() => snapshotResponse(invalid)).fetchImpl),
    ).rejects.toMatchObject({ code: "BAD_SNAPSHOT" });
    expect(await userIds()).toEqual([]);
    expect(await syncState()).toBeUndefined();

    // With a state stored: an extra, forbidden column in the body.
    const good = person();
    await pull(
      cloudThatAnswers(() =>
        snapshotResponse(
          build.snapshot({ users: [good.user], employees: [good.employee] }),
        ),
      ).fetchImpl,
      T1,
    );
    const before = await dump();
    const stateBefore = await syncState();
    const leaky = build.rawSnapshot({
      users: [{ ...good.user, passwordHash: "x" }, build.user()],
      employees: [good.employee],
    });
    await expect(
      pull(
        cloudThatAnswers(() => snapshotResponse(leaky, '"etag-2"')).fetchImpl,
        T2,
      ),
    ).rejects.toMatchObject({ code: "BAD_SNAPSHOT" });
    expect(await dump()).toEqual(before);
    expect(await syncState()).toEqual(stateBefore);
  });

  it("rejects snapshots exceeding inspection limits without applying them", async () => {
    const base = build.rawSnapshot({});
    let deep: unknown = "value";
    for (let index = 0; index < 9; index++) deep = { nested: deep };
    for (const future of [deep]) {
      const body = { ...base, future };
      await expect(
        pull(cloudThatAnswers(() => snapshotResponse(body)).fetchImpl),
      ).rejects.toMatchObject({ code: "BAD_SNAPSHOT" });
      expect(await userIds()).toEqual([]);
      expect(await syncState()).toBeUndefined();
    }
  });

  it("a 200 without an ETag is refused and nothing is applied", async () => {
    const a = person();
    await expect(
      pull(
        cloudThatAnswers(() =>
          snapshotResponse(
            build.snapshot({ users: [a.user], employees: [a.employee] }),
            null,
          ),
        ).fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(await userIds()).toEqual([]);
    expect(await syncState()).toBeUndefined();
  });

  it("a cloud error changes nothing and reports a code without the credential", async () => {
    const a = person();
    await pull(
      cloudThatAnswers(() =>
        snapshotResponse(
          build.snapshot({ users: [a.user], employees: [a.employee] }),
        ),
      ).fetchImpl,
      T1,
    );
    const before = await dump();
    const stateBefore = await syncState();

    const failure = await pull(
      cloudThatAnswers(() => new Response("boom", { status: 500 })).fetchImpl,
      T2,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "CLOUD_HTTP_500" });
    expect(String((failure as Error).message)).not.toContain(credential);
    expect(await dump()).toEqual(before);
    expect(await syncState()).toEqual(stateBefore);
  });

  it("applies a snapshot built by the cloud service for this outlet", async () => {
    const userId = randomUUID();
    createdUsers.push(userId);
    await mainOwner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Staf nyata cloud', $2, true)`,
      [userId, `nyata-${userId.slice(0, 8)}@example.test`],
    );
    const employeeNo = `CL-${userId.slice(0, 6).toUpperCase()}`;
    await mainOwner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan nyata cloud', $5, 'pkwtt', '2025-03-01', 'active')`,
      [randomUUID(), tenantId, userId, employeeNo, outletId],
    );
    const node = {
      tenantId: tenantIdSchema.parse(tenantId),
      outletId: outletIdSchema.parse(outletId),
      edgeNodeId: randomUUID(),
    } as unknown as VerifiedEdgeNode;
    const built = await buildEdgePeopleSnapshot(node);

    const cloud = cloudThatAnswers((seen) =>
      seen.ifNoneMatch === built.etag
        ? notModified()
        : snapshotResponse(built.body, built.etag),
    );
    expect(await pull(cloud.fetchImpl, T1)).toMatchObject({
      status: "applied",
    });

    expect(await userIds()).toContain(userId);
    const sent = await edge.rows(
      `SELECT email, email_verified FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(sent).toEqual([
      { email: `${userId}@edge.invalid`, email_verified: false },
    ]);
    expect(
      await edge.rows(
        `SELECT employee_no, status, home_outlet_id FROM employees WHERE user_id = $1`,
        [userId],
      ),
    ).toEqual([
      { employee_no: employeeNo, status: "active", home_outlet_id: outletId },
    ]);
    expect((await syncState())!.snapshot_etag).toBe(built.etag);

    // The same ETag again: the cloud answers 304 and the data stays.
    expect(await pull(cloud.fetchImpl, T2)).toMatchObject({
      status: "unchanged",
    });
    expect(cloud.seen.at(-1)!.ifNoneMatch).toBe(built.etag);
    expect((await syncState())!.last_checked_at).toEqual(T2);
  });
});
