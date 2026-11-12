import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPurchasingFixtures,
  createSupplierInputSchema,
  updateSupplierInputSchema,
  supplierQuerySchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const client = agent(createApp());
let userId: string;
const supplierIds: string[] = [];

beforeAll(async () => {
  await signUp(client, "WS06 supplier kinds");
  userId = (await client.get("/api/auth/get-session")).body.user.id;
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
    SELECT $1, $2, id, 'tenant', now() - interval '1 hour', $2 FROM roles WHERE tenant_id = $1 AND template_key = 'purchasing'`,
    [tenantId, userId],
  );
});
afterAll(async () => {
  await owner.query(
    "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation = 'supplier.create' AND response->>'id' = ANY($2::text[])",
    [tenantId, supplierIds],
  );
  await owner.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    supplierIds,
  ]);
  await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
    userId,
  ]);
  await owner.end();
});

describe("legend-dnex supplier kind", () => {
  it("defaults legacy creates to goods and accepts maintenance without broadening the enum", () => {
    const input = {
      name: "Teknisi Mesin",
      paymentTermsDays: 7,
      idempotencyKey: `kind-${randomUUID()}`,
    };
    expect(createSupplierInputSchema.safeParse(input).success).toBe(true);
    expect(
      createSupplierInputSchema.safeParse({ ...input, kind: "maintenance" })
        .success,
    ).toBe(true);
    expect(
      createSupplierInputSchema.safeParse({ ...input, kind: "other" }).success,
    ).toBe(false);
    expect(
      updateSupplierInputSchema.safeParse({
        kind: "maintenance",
        expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(supplierQuerySchema.parse({ kind: "maintenance" })).toMatchObject({
      kind: "maintenance",
    });
  });

  it("provides a technician supplier fixture for maintenance screens", () => {
    const maintenance = cafeLegendPurchasingFixtures.suppliers.filter(
      (row) => Reflect.get(row, "kind") === "maintenance",
    );
    expect(maintenance.length).toBeGreaterThan(0);
    expect(
      maintenance.some((row) => /teknisi|maintenance|servis/i.test(row.name)),
    ).toBe(true);
    expect(
      cafeLegendPurchasingFixtures.suppliers.some(
        (row) => Reflect.get(row, "kind") === "goods",
      ),
    ).toBe(true);
  });

  it("persists kind through create, read, filtered list and update", async () => {
    const created = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send({
        name: `Teknisi WS06 ${randomUUID()}`,
        kind: "maintenance",
        paymentTermsDays: 7,
        idempotencyKey: `kind-${randomUUID()}`,
      });
    expect(created.status).toBe(201);
    supplierIds.push(created.body.data.id);
    expect(created.body.data.kind).toBe("maintenance");
    const detail = await client.get(
      `/api/inventory/suppliers/${created.body.data.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.supplier.kind).toBe("maintenance");
    const list = await client.get("/api/inventory/suppliers?kind=maintenance");
    expect(list.status).toBe(200);
    expect(
      list.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(true);
    expect(
      list.body.data.every(
        (row: { kind: string }) => row.kind === "maintenance",
      ),
    ).toBe(true);
    const patched = await client
      .patch(`/api/inventory/suppliers/${created.body.data.id}`)
      .set(originHeader)
      .send({ kind: "goods", expectedUpdatedAt: created.body.data.updatedAt });
    expect(patched.status).toBe(200);
    expect(patched.body.data.kind).toBe("goods");
    const maintenance = await client.get(
      "/api/inventory/suppliers?kind=maintenance",
    );
    expect(
      maintenance.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(false);
  });
  it("defaults legacy creates to goods and preserves replay identity", async () => {
    const input = {
      name: `Goods WS06 ${randomUUID()}`,
      paymentTermsDays: 7,
      idempotencyKey: `legacy-kind-${randomUUID()}`,
    };
    const first = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send(input);
    expect(first.status).toBe(201);
    supplierIds.push(first.body.data.id);
    expect(first.body.data.kind).toBe("goods");
    const replay = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send({ ...input, kind: "goods" });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const changed = await client
      .post("/api/inventory/suppliers")
      .set(originHeader)
      .send({ ...input, kind: "maintenance" });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
