// Outbox events for sessions and tenants (beads legend-83ll, legend-fy5y).
// Calls the services directly against the disposable PostgreSQL database: the
// app pool runs as legend_app (RLS applies), checks read back as the owner.
import { randomBytes, randomUUID } from "node:crypto";
import { idr, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { CreateTenantInput } from "@starter/shared/platform";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { consumeOutbox } from "../services/core-outbox.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  appendSessionRevoked,
  deliverIdentityEvent,
} from "../services/identity-events.ts";
import { revokeOwnSession } from "../services/identity-session.service.ts";
import {
  createTenant,
  setTenantPackage,
  setTenantStatus,
} from "../services/platform-org.service.ts";
import { createBuiltinWorkerTransport } from "../worker/transport.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let actorUserId: string;

const limits: CreateTenantInput["limits"] = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: idr(0),
  aiCostCapIdr: idr(50_000),
  emailCostCapIdr: idr(10_000),
};

function scope(tenantId: string) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function newTenant(): Promise<string> {
  const tenant = await createTenant(
    {
      slug: `evt-${randomBytes(4).toString("hex")}`,
      name: "Uji Event",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Event",
        whatsapp: `62812${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`,
        email: null,
      },
    },
    actorUserId,
  );
  return tenant.id;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pengguna Event', $2, true)`,
    [id, `evt-${id}@example.com`],
  );
  return id;
}

async function newSession(
  userId: string,
  tenantId: string | null,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO session (id, expires_at, token, user_id, tenant_id)
     VALUES ($1, now() + interval '1 day', $2, $3, $4)`,
    [id, randomBytes(16).toString("hex"), userId, tenantId],
  );
  return id;
}

async function sessionOutbox(sessionId: string) {
  const { rows } = await owner.query<{
    id: string;
    destination: string;
    sequence: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT id, destination, sequence, event FROM domain_event_outbox
      WHERE aggregate_type = 'session' AND aggregate_id = $1 ORDER BY sequence`,
    [sessionId],
  );
  return rows;
}

async function tenantOutbox(tenantId: string) {
  const { rows } = await owner.query<{
    destination: string;
    sequence: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT destination, sequence, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'tenant' ORDER BY sequence`,
    [tenantId],
  );
  return rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorUserId = await newUser();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  await owner.end();
});

describe("session.revoked through the outbox (legend-83ll)", () => {
  it("revoking a tenant session appends one identity event in the same transaction, once", async () => {
    const tenantId = await newTenant();
    const userId = await newUser();
    const sessionId = await newSession(userId, tenantId);

    await revokeOwnSession({ userId, sessionId });
    // Idempotent: a second revoke writes nothing more.
    await revokeOwnSession({ userId, sessionId });

    const rows = await sessionOutbox(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destination: "identity", sequence: "1" });
    expect(rows[0]?.event.name).toBe("session.revoked");
    expect(rows[0]?.event.payload).toEqual({
      sessionId,
      userId,
      cause: "revoked_by_user",
    });
    const { rows: stored } = await owner.query(
      "SELECT revoked_at FROM session WHERE id = $1",
      [sessionId],
    );
    expect(stored[0].revoked_at).not.toBeNull();
  });

  it("a platform session (no tenant) is revoked without an event", async () => {
    const userId = await newUser();
    const sessionId = await newSession(userId, null);
    await revokeOwnSession({ userId, sessionId });
    expect(await sessionOutbox(sessionId)).toHaveLength(0);
    const { rows } = await owner.query(
      "SELECT revoked_at FROM session WHERE id = $1",
      [sessionId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("the registered consumer closes the session and acks; replay is a no-op", async () => {
    const tenantId = await newTenant();
    const context = scope(tenantId);
    const userId = await newUser();
    const sessionId = await newSession(userId, tenantId);
    // Event without the row update: a producer that only emitted the event.
    await withTenant(db, context, (tx) =>
      appendSessionRevoked(tx, context, {
        sessionId,
        userId,
        cause: "account_locked",
        now: new Date(),
      }),
    );
    const [row] = await sessionOutbox(sessionId);
    const input = {
      outboxId: uuidToUlid(row!.id),
      authorize: async () => true,
      deliver: async (
        event: Parameters<typeof deliverIdentityEvent>[1],
        _key: string,
        tx: Parameters<typeof deliverIdentityEvent>[2],
      ) => deliverIdentityEvent(context, event, tx),
    };
    await consumeOutbox(db, context, input);
    const { rows } = await owner.query(
      "SELECT revoked_at, expires_at <= now() AS expired FROM session WHERE id = $1",
      [sessionId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].expired).toBe(true);
    await consumeOutbox(db, context, input);
  });

  it("the consumer refuses an event name it does not know", async () => {
    const tenantId = await newTenant();
    const context = scope(tenantId);
    const [created] = await tenantOutbox(tenantId);
    await expect(
      deliverIdentityEvent(
        context,
        { ...created!.event, tenantId } as never,
        {} as never,
      ),
    ).rejects.toThrow("No identity consumer");
  });

  it("the built-in transport accepts the identity destination as a local sink", async () => {
    const transport = createBuiltinWorkerTransport({
      database: {} as never,
      env: {},
    });
    const tenantId = await newTenant();
    const context = scope(tenantId);
    const [created] = await tenantOutbox(tenantId);
    const route = { destination: "identity", direction: null, peerId: null };
    await expect(
      transport.deliverEvent(
        context,
        created!.event as never,
        "key",
        {} as never,
        route,
      ),
    ).resolves.toBeUndefined();
    await expect(
      transport.deliverEvent(
        context,
        created!.event as never,
        "key",
        {} as never,
        { ...route, destination: "elsewhere" },
      ),
    ).rejects.toThrow("Unsupported outbox destination");
  });
});

describe("tenant.status_changed / tenant.package_changed (legend-fy5y)", () => {
  it("emit events in the tenant stream after tenant.created; a no-op status change emits none", async () => {
    const tenantId = await newTenant();
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Tidak membayar tagihan bulan ini." },
      actorUserId,
    );
    await setTenantStatus(
      tenantId,
      { status: "suspended", reason: "Masih belum membayar tagihan." },
      actorUserId,
    );
    await setTenantPackage(
      tenantId,
      {
        plan: "outlet-dasar",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits: { ...limits, maxOutlets: 1 },
        reason: "Turun ke paket outlet dasar.",
      },
      actorUserId,
    );
    const rows = await tenantOutbox(tenantId);
    expect(rows.map((row) => [row.sequence, row.event.name])).toEqual([
      ["1", "tenant.created"],
      ["2", "tenant.status_changed"],
      ["3", "tenant.package_changed"],
    ]);
    expect(rows.every((row) => row.destination === "cloud-sync")).toBe(true);
    expect(rows[1]?.event.payload).toEqual({
      from: "active",
      to: "suspended",
      reason: "Tidak membayar tagihan bulan ini.",
    });
    expect(rows[2]?.event.payload).toEqual({
      plan: "outlet-dasar",
      modulesEnabled: [],
      modulesDisabled: ["qr_order"],
      limitsChanged: ["maxOutlets"],
      reason: "Turun ke paket outlet dasar.",
    });
  });

  it("a rejected transition emits no event", async () => {
    const tenantId = await newTenant();
    await setTenantStatus(
      tenantId,
      { status: "archived", reason: "Tutup permanen usaha ini." },
      actorUserId,
    );
    await expect(
      setTenantStatus(
        tenantId,
        { status: "suspended", reason: "Tidak boleh dari arsip." },
        actorUserId,
      ),
    ).rejects.toBeDefined();
    const names = (await tenantOutbox(tenantId)).map((row) => row.event.name);
    expect(names).toEqual(["tenant.created", "tenant.status_changed"]);
  });
});
