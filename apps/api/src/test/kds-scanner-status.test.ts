// Edge KDS scanner status reported by the device (beads legend-40nvj).
// Contract: docs/design/edge-kds-scanner-status.md, written against the design
// and never against the service.
//
// - POST /api/devices/heartbeat accepts an optional
//   `scanner: { status: "connected" | "disconnected"; observedAt: ISO }`.
//   It is stored in devices.scanner_status / devices.scanner_observed_at; a
//   heartbeat without `scanner` leaves both columns alone; an `observedAt` in the
//   future is clamped to the server clock.
// - GET /api/outlets/:outletId/kitchen/scanner-status answers
//   `{ data: { status: "connected" | "disconnected" | "unknown" } }` from the
//   live (not offline, not revoked) KDS devices of that outlet.
//
// Assumptions where the design is silent:
// - A future `observedAt` never refuses the heartbeat: it is clamped to the
//   server clock (last_seen_at still advances).
// - A malformed `scanner` (unknown status, extra key) is a 4xx too, nothing
//   stored (the heartbeat body is a strict object).
// - "Live" = last_seen_at within 120 s (isDeviceOffline). Staleness is
//   simulated by moving last_seen_at back in the database; a revoked device
//   reports first, then is revoked (a revoked token cannot heartbeat).
// - Only devices of type `kds` count: a POS tablet reporting `connected` does
//   not turn the outlet `connected`.
// - Read access: `kds.station.manage` and `kds.ticket.process` both pass
//   (tenant scope); a role with neither, no session, another outlet's
//   outlet-scoped manager and another tenant are refused (401/403/404).
// - The response may carry more than `status`; only `status` is asserted.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const short = () => randomUUID().slice(0, 6);

type Member = { client: ReturnType<typeof agent>; userId: string };
type Device = { id: string; token: string };
type ScannerState = {
  scanner_status: string | null;
  scanner_observed_at: Date | null;
};

const roleIds = {
  manage: randomUUID(),
  cook: randomUUID(),
  none: randomUUID(),
  manageB: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let manager: Member; // kds.station.manage, tenant scope
let cook: Member; // kds.ticket.process only, tenant scope
let nobody: Member; // a role with neither KDS permission
let tenantBManager: Member;
let otherOutletId: string;
let otherOutletManager: Member; // kds.station.manage on otherOutletId only
let otherOutletCook: Member; // kds.ticket.process on otherOutletId only

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

/** `devices` is FORCE RLS: even the owner needs the tenant settings. */
async function asTenant<T extends Record<string, unknown> = never>(
  forTenant: IsolatedTenant,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenant.tenantId],
    );
    const result = await client.query<T>(text, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A fresh outlet of tenant A, so every scenario owns its devices. */
async function makeOutlet(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $3, 'Jl. Uji 4', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $4 AND id = $5`,
    [
      id,
      `SC-${short()}`.toUpperCase(),
      `Outlet ${label}`,
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  return id;
}

async function makeDevice(
  forTenant: IsolatedTenant,
  outletId: string,
  type: "kds" | "pos" = "kds",
): Promise<Device> {
  const id = randomUUID();
  await asTenant(
    forTenant,
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [id, forTenant.tenantId, outletId, type, `${type} ${short()}`],
  );
  const token = signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: forTenant.tenantId,
    brandId: null,
    deviceId: id,
  });
  return { id, token };
}

function heartbeat(
  device: Device,
  body: Record<string, unknown> = {},
  forHeaders: { Host: string } = headers,
) {
  return request(app)
    .post("/api/devices/heartbeat")
    .set(forHeaders)
    .set(DEVICE_TOKEN_HEADER, device.token)
    .send({
      version: "1.0.0",
      capabilities: ["print"],
      occurredAt: new Date().toISOString(),
      ...body,
    });
}

const scanner = (
  status: "connected" | "disconnected",
  observedAt: Date = new Date(),
) => ({ status, observedAt: observedAt.toISOString() });

/** Device reports a scanner state through the real heartbeat route. */
async function report(
  device: Device,
  status: "connected" | "disconnected",
  forHeaders: { Host: string } = headers,
) {
  const res = await heartbeat(device, { scanner: scanner(status) }, forHeaders);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function stored(
  device: Device,
  forTenant: IsolatedTenant = tenant,
): Promise<ScannerState & { last_seen_at: Date | null }> {
  const rows = await asTenant<ScannerState & { last_seen_at: Date | null }>(
    forTenant,
    `SELECT scanner_status, scanner_observed_at, last_seen_at
     FROM devices WHERE id = $1`,
    [device.id],
  );
  return rows[0]!;
}

/** Make a device's last heartbeat older than the 120 s offline threshold. */
async function goStale(device: Device, forTenant: IsolatedTenant = tenant) {
  await asTenant(
    forTenant,
    `UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`,
    [device.id],
  );
}

async function revoke(device: Device, forTenant: IsolatedTenant = tenant) {
  await asTenant(
    forTenant,
    `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [device.id],
  );
}

function read(
  who: Member | null,
  outletId: string,
  forHeaders: { Host: string } = headers,
) {
  const client = who?.client ?? agent(app);
  return client
    .get(`/api/outlets/${outletId}/kitchen/scanner-status`)
    .set(forHeaders)
    .set(originHeader);
}

async function statusOf(outletId: string, who: Member = manager) {
  const res = await read(who, outletId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.status as string;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`scn-${short()}`);
  tenantB = await createIsolatedTenant(`scnb-${short()}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    roleIds.manage,
    "Pengelola Stasiun",
    ["kds.station.manage"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    roleIds.cook,
    "Koki Saja",
    ["kds.ticket.process"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    roleIds.none,
    "Tanpa Izin KDS",
    ["floor.table.view"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenantB.tenantId,
    roleIds.manageB,
    "Pengelola Stasiun B",
    ["kds.station.manage"],
    ["tenant"],
  );

  otherOutletId = await makeOutlet("Lain");
  manager = await member(
    tenant,
    roleIds.manage,
    { type: "tenant", id: null },
    "Pengelola Pemindai",
  );
  cook = await member(
    tenant,
    roleIds.cook,
    { type: "tenant", id: null },
    "Koki Pemindai",
  );
  nobody = await member(
    tenant,
    roleIds.none,
    { type: "tenant", id: null },
    "Tanpa Izin Pemindai",
  );
  otherOutletManager = await member(
    tenant,
    roleIds.manage,
    { type: "outlet", id: otherOutletId },
    "Pengelola Outlet Lain Pemindai",
  );
  otherOutletCook = await member(
    tenant,
    roleIds.cook,
    { type: "outlet", id: otherOutletId },
    "Koki Outlet Lain Pemindai",
  );
  tenantBManager = await member(
    tenantB,
    roleIds.manageB,
    { type: "tenant", id: null },
    "Pengelola Tenant B Pemindai",
  );
});

afterAll(async () => {
  // Rows stay in the disposable database, like the other KDS tests.
});

describe("POST /api/devices/heartbeat with scanner", () => {
  it("stores the reported scanner status and observedAt", async () => {
    const outletId = await makeOutlet("H1");
    const device = await makeDevice(tenant, outletId);
    expect((await stored(device)).scanner_status).toBeNull();

    const observedAt = new Date(Date.now() - 20_000);
    const res = await heartbeat(device, {
      scanner: scanner("connected", observedAt),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await stored(device);
    expect(row.scanner_status).toBe("connected");
    expect(row.scanner_observed_at?.getTime()).toBe(observedAt.getTime());
    expect(row.last_seen_at).not.toBeNull();
  });

  it("replaces the stored status when the scanner changes", async () => {
    const outletId = await makeOutlet("H2");
    const device = await makeDevice(tenant, outletId);
    await report(device, "connected");
    const later = new Date(Date.now() - 1_000);
    const res = await heartbeat(device, {
      scanner: scanner("disconnected", later),
    });
    expect(res.status).toBe(200);
    const row = await stored(device);
    expect(row.scanner_status).toBe("disconnected");
    expect(row.scanner_observed_at?.getTime()).toBe(later.getTime());
  });

  it("a heartbeat without scanner leaves both columns unchanged", async () => {
    const outletId = await makeOutlet("H3");
    const device = await makeDevice(tenant, outletId);
    // Never reported: stays null after a plain heartbeat (old shells stay valid).
    expect((await heartbeat(device)).status).toBe(200);
    expect(await stored(device)).toMatchObject({
      scanner_status: null,
      scanner_observed_at: null,
    });

    await report(device, "connected");
    const before = await stored(device);
    expect(before.scanner_status).toBe("connected");

    const res = await heartbeat(device);
    expect(res.status).toBe(200);
    const after = await stored(device);
    expect(after.scanner_status).toBe("connected");
    expect(after.scanner_observed_at?.getTime()).toBe(
      before.scanner_observed_at?.getTime(),
    );
  });

  it("accepts an observedAt a little in the future (within 5 minutes)", async () => {
    const outletId = await makeOutlet("H4");
    const device = await makeDevice(tenant, outletId);
    const res = await heartbeat(device, {
      scanner: scanner("connected", new Date(Date.now() + 60_000)),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(device)).scanner_status).toBe("connected");
  });

  it("accepts an observedAt far in the future: the heartbeat lands and observedAt is clamped to now", async () => {
    const outletId = await makeOutlet("H5");
    const device = await makeDevice(tenant, outletId);
    const sentAt = Date.now();
    const res = await heartbeat(device, {
      scanner: scanner("connected", new Date(sentAt + 10 * 60_000)),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const first = await stored(device);
    expect(first.scanner_status).toBe("connected");
    expect(first.last_seen_at).not.toBeNull();
    expect(first.scanner_observed_at!.getTime()).toBeGreaterThanOrEqual(
      sentAt - 1_000,
    );
    expect(first.scanner_observed_at!.getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );

    // A later heartbeat with an absurd time still moves last_seen_at forward
    // and never stores an observedAt ahead of the server clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await heartbeat(device, {
      scanner: scanner("disconnected", new Date(sentAt + 60 * 60_000)),
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const second = await stored(device);
    expect(second.scanner_status).toBe("disconnected");
    expect(second.last_seen_at!.getTime()).toBeGreaterThan(
      first.last_seen_at!.getTime(),
    );
    expect(second.scanner_observed_at!.getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );
  });

  const malformed: [string, unknown][] = [
    [
      "an unknown status",
      { status: "wedged", observedAt: new Date().toISOString() },
    ],
    ["a missing observedAt", { status: "connected" }],
    ["a missing status", { observedAt: new Date().toISOString() }],
    [
      "an observedAt that is not a date",
      { status: "connected", observedAt: "kemarin" },
    ],
    [
      "an unknown key",
      {
        status: "connected",
        observedAt: new Date().toISOString(),
        model: "x",
      },
    ],
  ];
  it.each(malformed)("refuses %s and stores nothing", async (_l, body) => {
    const outletId = await makeOutlet(`HM${short()}`);
    const device = await makeDevice(tenant, outletId);
    const res = await heartbeat(device, { scanner: body });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await stored(device)).scanner_status).toBeNull();
  });

  it("still needs a device token", async () => {
    const res = await request(app)
      .post("/api/devices/heartbeat")
      .set(headers)
      .send({
        version: "1.0.0",
        capabilities: [],
        occurredAt: new Date().toISOString(),
        scanner: scanner("connected"),
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("GET kitchen/scanner-status", () => {
  it("is unknown when no device has reported", async () => {
    const outletId = await makeOutlet("R1");
    expect(await statusOf(outletId)).toBe("unknown");
    // A live KDS device that never reported a scanner is still unknown.
    const device = await makeDevice(tenant, outletId);
    expect((await heartbeat(device)).status).toBe(200);
    expect(await statusOf(outletId)).toBe("unknown");
  });

  it("is connected when a live KDS device reports connected", async () => {
    const outletId = await makeOutlet("R2");
    const device = await makeDevice(tenant, outletId);
    await report(device, "connected");
    expect(await statusOf(outletId)).toBe("connected");
  });

  it("is disconnected when every live KDS device reports disconnected", async () => {
    const outletId = await makeOutlet("R3");
    const a = await makeDevice(tenant, outletId);
    const b = await makeDevice(tenant, outletId);
    await report(a, "disconnected");
    await report(b, "disconnected");
    expect(await statusOf(outletId)).toBe("disconnected");
  });

  it("is connected when one device is connected and another disconnected", async () => {
    const outletId = await makeOutlet("R4");
    const a = await makeDevice(tenant, outletId);
    const b = await makeDevice(tenant, outletId);
    await report(a, "disconnected");
    await report(b, "connected");
    expect(await statusOf(outletId)).toBe("connected");
  });

  it("follows the device: connected, then disconnected after the shell reports it", async () => {
    const outletId = await makeOutlet("R5");
    const device = await makeDevice(tenant, outletId);
    await report(device, "connected");
    expect(await statusOf(outletId)).toBe("connected");
    await report(device, "disconnected");
    expect(await statusOf(outletId)).toBe("disconnected");
  });

  it("ignores a device without a report next to a disconnected one", async () => {
    const outletId = await makeOutlet("R6");
    const silent = await makeDevice(tenant, outletId);
    const off = await makeDevice(tenant, outletId);
    expect((await heartbeat(silent)).status).toBe(200);
    await report(off, "disconnected");
    expect(await statusOf(outletId)).toBe("disconnected");
  });

  it("does not count a device with a stale heartbeat", async () => {
    const outletId = await makeOutlet("R7");
    const dead = await makeDevice(tenant, outletId);
    await report(dead, "connected");
    expect(await statusOf(outletId)).toBe("connected");
    await goStale(dead);
    // A dead tablet never makes the outlet "connected".
    expect(await statusOf(outletId)).toBe("unknown");

    // With a live device that is disconnected, the answer is disconnected.
    const live = await makeDevice(tenant, outletId);
    await report(live, "disconnected");
    expect(await statusOf(outletId)).toBe("disconnected");
  });

  it("does not count a revoked device", async () => {
    const outletId = await makeOutlet("R8");
    const gone = await makeDevice(tenant, outletId);
    await report(gone, "connected");
    expect(await statusOf(outletId)).toBe("connected");
    await revoke(gone);
    expect(await statusOf(outletId)).toBe("unknown");

    const live = await makeDevice(tenant, outletId);
    await report(live, "disconnected");
    expect(await statusOf(outletId)).toBe("disconnected");
  });

  it("only counts KDS devices", async () => {
    const outletId = await makeOutlet("R9");
    const pos = await makeDevice(tenant, outletId, "pos");
    await report(pos, "connected");
    expect(await statusOf(outletId)).toBe("unknown");
  });

  it("never mixes in devices of another outlet of the same tenant", async () => {
    const mine = await makeOutlet("R10");
    const elsewhere = await makeOutlet("R10x");
    const device = await makeDevice(tenant, elsewhere);
    await report(device, "connected");
    expect(await statusOf(elsewhere)).toBe("connected");
    expect(await statusOf(mine)).toBe("unknown");
  });

  it("never leaks a device of another tenant", async () => {
    const outletId = await makeOutlet("R11");
    const foreign = await makeDevice(tenantB, tenantB.outletId);
    await report(foreign, "connected", headersB);
    expect(await statusOf(outletId)).toBe("unknown");
    // Tenant B sees its own device, tenant A's outlet is out of reach.
    const theirs = await read(tenantBManager, tenantB.outletId, headersB);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data.status).toBe("connected");
    const cross = await read(tenantBManager, outletId, headersB);
    expect([403, 404]).toContain(cross.status);
  });

  it("answers the contract shape: a data object with a status string", async () => {
    const outletId = await makeOutlet("R12");
    const res = await read(manager, outletId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({ status: expect.any(String) }),
    );
    expect(["connected", "disconnected", "unknown"]).toContain(
      res.body.data.status,
    );
  });
});

describe("GET kitchen/scanner-status: authorization", () => {
  it("lets kds.station.manage read it", async () => {
    const outletId = await makeOutlet("A1");
    expect((await read(manager, outletId)).status).toBe(200);
  });

  it("lets kds.ticket.process read it (a cook's KDS page)", async () => {
    const outletId = await makeOutlet("A2");
    const device = await makeDevice(tenant, outletId);
    await report(device, "connected");
    const res = await read(cook, outletId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("connected");
  });

  it("answers 403 for a role with neither KDS permission", async () => {
    const outletId = await makeOutlet("A3");
    expect((await read(nobody, outletId)).status).toBe(403);
  });

  it("answers 401 without a session", async () => {
    const outletId = await makeOutlet("A4");
    expect((await read(null, outletId)).status).toBe(401);
  });

  it("answers 403 for a manager of another outlet", async () => {
    const outletId = await makeOutlet("A5");
    expect((await read(otherOutletManager, outletId)).status).toBe(403);
  });

  it("answers 403 for a cook with permission on one outlet who reads ANOTHER outlet", async () => {
    const outletId = await makeOutlet("A7");
    const device = await makeDevice(tenant, outletId);
    await report(device, "connected");
    const res = await read(otherOutletCook, outletId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.data?.status).toBeUndefined();
  });

  it("serves an outlet-scoped manager their own outlet", async () => {
    expect((await read(otherOutletManager, otherOutletId)).status).toBe(200);
  });

  it("lets an outlet-scoped reader (not tenant-wide) see a connected device in their own outlet", async () => {
    const device = await makeDevice(tenant, otherOutletId);
    await report(device, "connected");
    for (const who of [otherOutletManager, otherOutletCook]) {
      const res = await read(who, otherOutletId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("connected");
    }
  });

  it("answers 401/403/404 for tenant A's manager on tenant B's host and outlet", async () => {
    const res = await read(manager, tenantB.outletId, headersB);
    expect([401, 403, 404]).toContain(res.status);
  });

  it("is a read-only route: POST is not served", async () => {
    const outletId = await makeOutlet("A6");
    const res = await manager.client
      .post(`/api/outlets/${outletId}/kitchen/scanner-status`)
      .set(headers)
      .set(originHeader)
      .send({ status: "connected" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await statusOf(outletId)).toBe("unknown");
  });
});
