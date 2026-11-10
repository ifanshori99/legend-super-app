// Petty purchase (Pembelian Sederhana): limit, photo evidence, event (bead
// legend-65mgw, PRD v1.7 §3.18, brief 301b section 4). Needs the disposable
// PostgreSQL database; the migration owner seeds fixtures, the restricted
// legend_app login checks RLS, requests go through the real routes.
//
// Acceptance ids used in test names:
// - 65mgw-PP-1 limit policy: deny by default, upsert, outlet row wins
// - 65mgw-PP-2 record: row, photo link, audit, id-only event, no stock
// - 65mgw-PP-3 limit: refused above it, allowed at it, nothing is written
// - 65mgw-PP-4 idempotent create
// - 65mgw-PP-5 business date: no back-dating, no future or other-day paidAt
// - 65mgw-PP-6 photo must be the actor's own unlinked receipt object of this outlet
// - 65mgw-PP-7 permissions
// - 65mgw-PP-8 reads
// - 65mgw-PP-9 RLS and immutability
//
// Assumptions where the shared contract is silent:
// - Error responses use the `{ error: { code } }` envelope of the other suites.
// - A replayed create answers 200 or 201 (only the same id is pinned).
// - A bad photo answers 422 VALIDATION_ERROR.
// - An id-only read from another outlet answers 403 or 404.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateOf } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { outletBusinessDayClock } from "../services/outlet-clock.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();

const app = createApp();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const createdUserIds: string[] = [];
const createdStorageIds: string[] = [];

type Session = { client: ReturnType<typeof agent>; userId: string };
let recorder: Session;
let buyer: Session;
let finance: Session;
let warehouse: Session;
let nobody: Session;
let outletBManager: Session;
let today: string;

const key = () => `k-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

type Grant = { role: string; outletId: string | null };

async function signedIn(name: string, grants: Grant[]): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const grant of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantA,
        userId,
        await roleIdOf(grant.role),
        grant.outletId === null ? "tenant" : "outlet",
        grant.outletId,
      ],
    );
  return { client, userId };
}

/** Storage rows are seeded as the migration owner; `ownerUserId` is the uploader. */
async function insertPhoto(
  ownerUserId: string,
  options: { outletId?: string; purpose?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6)`,
    [
      tenantA,
      options.outletId ?? outletA,
      id,
      options.purpose ?? "receipt",
      `legend-65mgw/${id}.webp`,
      ownerUserId,
    ],
  );
  createdStorageIds.push(id);
  return id;
}

const record = (client: Session["client"], body: Record<string, unknown>) =>
  client
    .post("/api/inventory/petty-purchases")
    .set(originHeader)
    .send(body as object);

const putPolicy = (client: Session["client"], body: Record<string, unknown>) =>
  client
    .put("/api/inventory/petty-purchase-policy")
    .set(originHeader)
    .send(body as object);

async function purchaseBody(
  overrides: Record<string, unknown> = {},
  uploader: Session = recorder,
) {
  return {
    outletId: outletA,
    vendorName: "Pasar Induk",
    description: "Cabai dan bawang",
    amountIdr: 50000,
    photoMediaId: await insertPhoto(uploader.userId),
    idempotencyKey: key(),
    ...overrides,
  };
}

async function deletePolicies(): Promise<void> {
  await owner.query(
    "DELETE FROM petty_purchase_policies WHERE tenant_id = $1",
    [tenantA],
  );
}

async function setTenantLimit(limitIdr: number) {
  return putPolicy(finance.client, {
    outletId: null,
    limitIdr,
    idempotencyKey: key(),
  });
}

async function purchaseCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM petty_purchases WHERE tenant_id = $1",
    [tenantA],
  );
  return rows[0]!.n;
}

async function eventRows(purchaseId: string) {
  const { rows } = await owner.query<{
    aggregate_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT aggregate_type, event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'petty_purchase.recorded'`,
    [tenantA, purchaseId],
  );
  return rows;
}

async function auditActionsFor(objectId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
    [tenantA, objectId],
  );
  return rows.map((row) => row.action);
}

/** Runs `run` as the restricted runtime login with the given tenant and outlet scope. */
async function asScope<T>(
  tenantId: string,
  outletScope: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outletScope],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Petty Purchase Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `pp-b-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  recorder = await signedIn("PP recorder", [
    { role: "outlet_manager", outletId: outletA },
  ]);
  buyer = await signedIn("PP buyer", [
    { role: "purchasing", outletId: outletA },
  ]);
  finance = await signedIn("PP finance", [{ role: "finance", outletId: null }]);
  warehouse = await signedIn("PP warehouse", [
    { role: "warehouse", outletId: outletA },
  ]);
  nobody = await signedIn("PP nobody", []);
  outletBManager = await signedIn("PP manager B", [
    { role: "outlet_manager", outletId: outletB },
  ]);
  const { rows } = await owner.query<{
    timezone: string;
    business_day_cutoff: string;
  }>("SELECT timezone, business_day_cutoff FROM outlets WHERE id = $1", [
    outletA,
  ]);
  today = businessDateOf(
    new Date(),
    outletBusinessDayClock({
      timezone: rows[0]!.timezone,
      businessDayCutoff: rows[0]!.business_day_cutoff,
    }),
  );
});

afterAll(async () => {
  // Owner cleanup of its own fixtures; replica mode skips triggers and FKs.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const purchases = `(SELECT id FROM petty_purchases WHERE tenant_id = $1)`;
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${purchases}`,
      [tenantA],
    );
    await client.query("DELETE FROM petty_purchases WHERE tenant_id = $1", [
      tenantA,
    ]);
    await client.query(
      "DELETE FROM petty_purchase_policies WHERE tenant_id = $1",
      [tenantA],
    );
    await client.query(
      "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE 'petty_purchase%'",
      [tenantA],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [createdStorageIds],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
  await appPool.end();
});

describe("65mgw-PP petty purchase", () => {
  it("[65mgw-PP-1] no policy denies; PUT upserts the tenant default; an outlet row wins; only the policy manager writes", async () => {
    await deletePolicies();

    const missing = await recorder.client
      .get(`/api/inventory/petty-purchase-policy?outletId=${outletA}`)
      .set(originHeader);
    expect(missing.status).toBe(404);

    const denied = await record(recorder.client, await purchaseBody());
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("PETTY_PURCHASE_LIMIT_EXCEEDED");

    // The recorder reads the policy but cannot write it.
    const forbidden = await putPolicy(recorder.client, {
      outletId: null,
      limitIdr: 100000,
      idempotencyKey: key(),
    });
    expect(forbidden.status).toBe(403);
    expect(
      (
        await putPolicy(nobody.client, {
          outletId: outletA,
          limitIdr: 100000,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);

    const tenantKey = key();
    const body = {
      outletId: null,
      limitIdr: 500000,
      idempotencyKey: tenantKey,
    };
    const created = await putPolicy(finance.client, body);
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({
      tenantId: tenantA,
      outletId: null,
      limitIdr: 500000,
    });
    // Same key and body replays; same key, other body is refused.
    expect((await putPolicy(finance.client, body)).status).toBe(200);
    const reused = await putPolicy(finance.client, { ...body, limitIdr: 1 });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // A new key updates the one tenant row in place.
    expect((await setTenantLimit(600000)).status).toBe(200);
    const { rows: tenantRows } = await owner.query<{ limit_idr: string }>(
      "SELECT limit_idr::text AS limit_idr FROM petty_purchase_policies WHERE tenant_id = $1 AND outlet_id IS NULL",
      [tenantA],
    );
    expect(tenantRows).toEqual([{ limit_idr: "600000" }]);

    const effectiveTenant = await recorder.client
      .get(`/api/inventory/petty-purchase-policy?outletId=${outletA}`)
      .set(originHeader);
    expect(effectiveTenant.status).toBe(200);
    expect(effectiveTenant.body.data).toMatchObject({
      outletId: null,
      limitIdr: 600000,
    });

    const outletPut = await putPolicy(finance.client, {
      outletId: outletA,
      limitIdr: 200000,
      idempotencyKey: key(),
    });
    expect(outletPut.status).toBe(200);
    const effectiveOutlet = await finance.client
      .get(`/api/inventory/petty-purchase-policy?outletId=${outletA}`)
      .set(originHeader);
    expect(effectiveOutlet.body.data).toMatchObject({
      outletId: outletA,
      limitIdr: 200000,
    });
    const otherOutlet = await finance.client
      .get(`/api/inventory/petty-purchase-policy?outletId=${outletB}`)
      .set(originHeader);
    expect(otherOutlet.body.data).toMatchObject({
      outletId: null,
      limitIdr: 600000,
    });

    const actions = await auditActionsFor(outletA);
    expect(actions).toContain("purchasing.petty_policy_set");
    await deletePolicies();
  });

  it("[65mgw-PP-2] records the spend: row, applied limit, photo link, audit, id-only event, no stock", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const body = await purchaseBody({ note: "Dibayar tunai" });
    const before = await purchaseCount();

    const res = await record(recorder.client, body);
    expect(res.status).toBe(201);
    const purchase = res.body.data;
    expect(purchase).toMatchObject({
      tenantId: tenantA,
      outletId: outletA,
      vendorName: "Pasar Induk",
      description: "Cabai dan bawang",
      amountIdr: 50000,
      photoMediaId: body.photoMediaId,
      paidBy: recorder.userId,
      businessDate: today,
      note: "Dibayar tunai",
    });
    expect(await purchaseCount()).toBe(before + 1);

    const { rows } = await owner.query<{
      limit_idr_applied: string;
      photo_object_id: string;
    }>(
      "SELECT limit_idr_applied::text, photo_object_id FROM petty_purchases WHERE id = $1",
      [purchase.id],
    );
    expect(rows[0]).toEqual({
      limit_idr_applied: "100000",
      photo_object_id: body.photoMediaId,
    });

    const { rows: photo } = await owner.query<{
      source_kind: string;
      source_id: string;
    }>(
      "SELECT source_kind, source_id FROM core_storage_objects WHERE id = $1",
      [body.photoMediaId],
    );
    expect(photo[0]).toEqual({
      source_kind: "petty_purchase",
      source_id: purchase.id,
    });

    expect(await auditActionsFor(purchase.id)).toContain(
      "purchasing.petty_purchase_recorded",
    );
    const events = await eventRows(purchase.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_type).toBe("petty_purchase");
    expect(events[0]!.payload).toEqual({
      pettyPurchaseId: purchase.id,
      outletId: outletA,
      amountIdr: 50000,
      businessDate: today,
      paidBy: recorder.userId,
      paidAt: purchase.paidAt,
    });

    // A petty purchase is a spend record only: no ledger row names it.
    const { rows: ledger } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2",
      [tenantA, purchase.id],
    );
    expect(ledger[0]!.n).toBe(0);
  });

  it("[65mgw-PP-3] above the limit is refused and writes nothing; exactly the limit is allowed; an outlet limit wins", async () => {
    await deletePolicies();
    await setTenantLimit(75000);
    const before = await purchaseCount();

    const over = await record(
      recorder.client,
      await purchaseBody({ amountIdr: 75001 }),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("PETTY_PURCHASE_LIMIT_EXCEEDED");
    expect(await purchaseCount()).toBe(before);

    const exact = await record(
      recorder.client,
      await purchaseBody({ amountIdr: 75000 }),
    );
    expect(exact.status).toBe(201);

    // A stricter outlet row replaces the tenant default for that outlet only.
    await putPolicy(finance.client, {
      outletId: outletA,
      limitIdr: 10000,
      idempotencyKey: key(),
    });
    const tooMuch = await record(
      recorder.client,
      await purchaseBody({ amountIdr: 10001 }),
    );
    expect(tooMuch.status).toBe(409);
    const fits = await record(
      recorder.client,
      await purchaseBody({ amountIdr: 10000 }),
    );
    expect(fits.status).toBe(201);
    const { rows } = await owner.query<{ limit_idr_applied: string }>(
      "SELECT limit_idr_applied::text FROM petty_purchases WHERE id = $1",
      [fits.body.data.id],
    );
    expect(rows[0]!.limit_idr_applied).toBe("10000");
    await deletePolicies();
  });

  it("[65mgw-PP-4] a retry with the same key replays one purchase; another body with that key is refused", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const body = await purchaseBody();
    const first = await record(recorder.client, body);
    expect(first.status).toBe(201);
    const before = await purchaseCount();

    const replay = await record(recorder.client, body);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await purchaseCount()).toBe(before);
    expect(await eventRows(first.body.data.id)).toHaveLength(1);

    const reused = await record(recorder.client, { ...body, amountIdr: 1 });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[65mgw-PP-5] no back-dating; paidAt must not be in the future nor on another business day", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const before = await purchaseCount();

    const backDated = await record(
      recorder.client,
      await purchaseBody({ businessDate: "2000-01-01" }),
    );
    expect(backDated.status).toBe(422);
    expect(backDated.body.error.code).toBe("VALIDATION_ERROR");

    const future = await record(
      recorder.client,
      await purchaseBody({
        paidAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(future.status).toBe(422);

    const yesterday = await record(
      recorder.client,
      await purchaseBody({
        paidAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(yesterday.status).toBe(422);
    expect(await purchaseCount()).toBe(before);

    // Echoing today's business date and a paidAt a moment ago is fine.
    const paidAt = new Date(Date.now() - 1000).toISOString();
    const ok = await record(
      recorder.client,
      await purchaseBody({ businessDate: today, paidAt }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.businessDate).toBe(today);
    expect(ok.body.data.paidAt).toBe(paidAt);
  });

  it("[65mgw-PP-6] the photo must be your own unlinked receipt of this outlet; one photo documents one purchase", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const before = await purchaseCount();

    const othersPhoto = await insertPhoto(buyer.userId);
    const wrongPurpose = await insertPhoto(recorder.userId, {
      purpose: "menu_image",
    });
    const wrongOutlet = await insertPhoto(recorder.userId, {
      outletId: outletB,
    });
    for (const photoMediaId of [
      othersPhoto,
      wrongPurpose,
      wrongOutlet,
      randomUUID(),
    ]) {
      const res = await record(
        recorder.client,
        await purchaseBody({ photoMediaId }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await purchaseCount()).toBe(before);

    // A refused purchase leaves the photo free: nothing was linked.
    const { rows } = await owner.query<{ source_id: string | null }>(
      "SELECT source_id FROM core_storage_objects WHERE id = $1",
      [othersPhoto],
    );
    expect(rows[0]!.source_id).toBeNull();

    const photoMediaId = await insertPhoto(recorder.userId);
    const first = await record(
      recorder.client,
      await purchaseBody({ photoMediaId }),
    );
    expect(first.status).toBe(201);
    const second = await record(
      recorder.client,
      await purchaseBody({ photoMediaId }),
    );
    expect(second.status).toBe(422);
    expect(await purchaseCount()).toBe(before + 1);
  });

  it("[65mgw-PP-7] permissions: recorder roles can record; warehouse, nobody and another outlet cannot", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    expect(
      (await record(buyer.client, await purchaseBody({}, buyer))).status,
    ).toBe(201);
    for (const denied of [warehouse, nobody, outletBManager]) {
      const res = await record(denied.client, await purchaseBody({}, denied));
      expect(res.status).toBe(403);
    }
    expect(
      (await record(recorder.client, await purchaseBody({ outletId: outletB })))
        .status,
    ).toBe(403);
    expect((await record(agent(app), await purchaseBody())).status).toBe(401);
  });

  it("[65mgw-PP-8] reads: recorder and finance list and open a purchase; others and other outlets cannot", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const first = await record(recorder.client, await purchaseBody());
    const second = await record(
      recorder.client,
      await purchaseBody({ vendorName: "Toko Sembako" }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    for (const reader of [recorder, finance]) {
      const page = await reader.client
        .get(`/api/inventory/petty-purchases?outletId=${outletA}&limit=1`)
        .set(originHeader);
      expect(page.status).toBe(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.meta.nextCursor).not.toBeNull();
      const next = await reader.client
        .get(
          `/api/inventory/petty-purchases?outletId=${outletA}&limit=1&cursor=${encodeURIComponent(
            page.body.meta.nextCursor,
          )}`,
        )
        .set(originHeader);
      expect(next.status).toBe(200);
      expect(next.body.data[0].id).not.toBe(page.body.data[0].id);

      const one = await reader.client
        .get(`/api/inventory/petty-purchases/${first.body.data.id}`)
        .set(originHeader);
      expect(one.status).toBe(200);
      expect(one.body.data.id).toBe(first.body.data.id);
    }

    const dated = await recorder.client
      .get(
        `/api/inventory/petty-purchases?outletId=${outletA}&fromDate=2000-01-01&toDate=2000-01-02`,
      )
      .set(originHeader);
    expect(dated.body.data).toHaveLength(0);

    for (const denied of [nobody, warehouse]) {
      expect(
        (
          await denied.client
            .get(`/api/inventory/petty-purchases?outletId=${outletA}`)
            .set(originHeader)
        ).status,
      ).toBe(403);
      expect(
        (
          await denied.client
            .get(`/api/inventory/petty-purchases/${first.body.data.id}`)
            .set(originHeader)
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await outletBManager.client
          .get(`/api/inventory/petty-purchases?outletId=${outletA}`)
          .set(originHeader)
      ).status,
    ).toBe(403);
    const crossOutlet = await outletBManager.client
      .get(`/api/inventory/petty-purchases/${first.body.data.id}`)
      .set(originHeader);
    expect([403, 404]).toContain(crossOutlet.status);

    const bad = await recorder.client
      .get(`/api/inventory/petty-purchases?outletId=${outletA}&cursor=nope`)
      .set(originHeader);
    expect(bad.status).toBe(422);
  });

  it("[65mgw-PP-9] RLS: other tenants and outlets see nothing; the runtime login cannot update or delete a purchase", async () => {
    await deletePolicies();
    await setTenantLimit(100000);
    const res = await record(recorder.client, await purchaseBody());
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;

    expect(
      await asScope(tenantA, JSON.stringify([outletA]), async (client) => {
        const { rows } = await client.query(
          "SELECT id FROM petty_purchases WHERE id = $1",
          [id],
        );
        return rows.length;
      }),
    ).toBe(1);
    expect(
      await asScope(tenantA, JSON.stringify([outletB]), async (client) => {
        const { rows } = await client.query(
          "SELECT id FROM petty_purchases WHERE id = $1",
          [id],
        );
        return rows.length;
      }),
    ).toBe(0);
    expect(
      await asScope(tenantB, JSON.stringify([outletA]), async (client) => {
        const { rows } = await client.query(
          "SELECT id FROM petty_purchases WHERE id = $1",
          [id],
        );
        return rows.length;
      }),
    ).toBe(0);

    await expect(
      asScope(tenantA, JSON.stringify([outletA]), (client) =>
        client.query(
          "UPDATE petty_purchases SET amount_idr = 1 WHERE id = $1",
          [id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asScope(tenantA, JSON.stringify([outletA]), (client) =>
        client.query("DELETE FROM petty_purchases WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
