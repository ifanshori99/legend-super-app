// Printer registry CRUD (bead legend-2lp.6). Written from the "Card B contract"
// in docs/briefs/edge-device-security.md, not from the implementation. All
// assertions go through HTTP, so a missing router fails every test at its first
// call (404 / wrong status), never at an import.
//
// Contract:
//   GET    /api/printers?outletId=    -> { data: Printer[] }
//   GET    /api/printers/:printerId   -> { data: Printer }
//   POST   /api/printers              -> 201 { data: Printer }
//   PATCH  /api/printers/:printerId   -> 200 { data: Printer }
//   DELETE /api/printers/:printerId   -> 200/204; 409 while a fallback or has jobs
// Permission device.registry.manage (tenant-wide or in the printer's outlet).
//
// Assumptions (ambiguous in the brief):
//   - Success bodies are wrapped in `data` like the other back-office routes.
//   - Id format in bodies may be a uuid or a ULID: compared after normalising.
//   - Validation failure is 400 or 422; a missing/foreign station or fallback is
//     404 or 422; no permission is 403 or 404 (brief: "403/404").
//   - Delete answers 200 or 204.
//   - A PATCH that changes host/port/devicePath carries `transport` too (brief:
//     no transport-less partials); a missing station/fallback may be 400/404/422.
//   - Cross-tenant tests first create a real printer, so they cannot pass
//     vacuously while the route does not exist.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Member = { client: ReturnType<typeof agent>; userId: string };
type Headers = { Host: string };
type PrinterDto = Record<string, unknown> & { id: string };

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let headersA: Headers;
let headersB: Headers;
let managerTenantA: Member; // device.registry.manage tenant-wide
let managerOutletA1: Member; // device.registry.manage in outlet A1 only
let noPermissionA: Member;
let managerTenantB: Member;
let revokerA: Member; // manage + revoke, tenant-wide
let stationA1: string; // station of outlet A1
let stationA1b: string; // second station of outlet A1
let stationA2: string; // station of outlet A2
let stationB: string; // station of tenant B

// ---- helpers ------------------------------------------------------------------

const norm = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
const sameId = (a: unknown, b: unknown) => norm(String(a)) === norm(String(b));
/** DB uuid of an id the API returned. */
const dbId = (id: string) => norm(id);

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  tenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
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
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, tenantId, name, JSON.stringify(permissions)],
  );
  return id;
}

async function insertStation(
  tenant: IsolatedTenant,
  outletId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'beverage_bar')`,
      [id, tenant.tenantId, outletId, name],
    ),
  );
  return id;
}

const http = {
  list: (who: Member, headers: Headers, query = "") =>
    who.client.get(`/api/printers${query}`).set(headers).set(originHeader),
  get: (who: Member, headers: Headers, id: string) =>
    who.client
      .get(`/api/printers/${encodeURIComponent(id)}`)
      .set(headers)
      .set(originHeader),
  create: (who: Member, headers: Headers, body: Record<string, unknown>) =>
    who.client.post("/api/printers").set(headers).set(originHeader).send(body),
  patch: (
    who: Member,
    headers: Headers,
    id: string,
    body: Record<string, unknown>,
  ) =>
    who.client
      .patch(`/api/printers/${encodeURIComponent(id)}`)
      .set(headers)
      .set(originHeader)
      .send(body),
  remove: (who: Member, headers: Headers, id: string) =>
    who.client
      .delete(`/api/printers/${encodeURIComponent(id)}`)
      .set(headers)
      .set(originHeader),
};

let sequence = 0;
/** A valid network receipt printer body; overrides replace fields. */
function networkBody(
  outletId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  sequence += 1;
  return {
    outletId,
    label: `Printer uji ${sequence}`,
    role: "receipt",
    transport: "network",
    host: "192.168.1.50",
    port: 9100,
    paperWidth: 48,
    ...overrides,
  };
}

/** Creates through HTTP and asserts 201; returns the DTO. */
async function createPrinter(
  who: Member,
  headers: Headers,
  body: Record<string, unknown>,
): Promise<PrinterDto> {
  const response = await http.create(who, headers, body);
  expect(response.status).toBe(201);
  return response.body.data as PrinterDto;
}

const rejected = [400, 422];

async function printerRow(id: string) {
  const { rows } = await owner.query<{
    id: string;
    tenant_id: string;
    outlet_id: string;
    label: string;
    role: string;
    station_id: string | null;
    transport: string;
    host: string | null;
    port: number | null;
    device_path: string | null;
    paper_width: number;
    fallback_printer_id: string | null;
  }>("SELECT * FROM edge_printers WHERE id = $1::uuid", [dbId(id)]);
  return rows[0];
}

async function deviceRow(id: string) {
  const { rows } = await owner.query<{
    id: string;
    tenant_id: string;
    outlet_id: string;
    type: string;
    label: string;
    station_id: string | null;
    status: string;
    revoked_at: Date | null;
  }>("SELECT * FROM devices WHERE id = $1::uuid", [dbId(id)]);
  return rows[0];
}

async function stationPrinter(stationId: string) {
  const { rows } = await owner.query<{ printer_device_id: string | null }>(
    "SELECT printer_device_id FROM stations WHERE id = $1::uuid",
    [stationId],
  );
  return rows[0]!.printer_device_id;
}

async function printerCount(tenantId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM edge_printers WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

// ---- setup ----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  tenantA = await createIsolatedTenant(`prn-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`prn-b-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  headersB = { Host: tenantB.hostname };
  outletA1 = tenantA.outletId;
  outletA2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'PRN-A2', 'Outlet A2', 'Jl. Uji 2', 'Asia/Jakarta', $5, 'active')`,
    [
      outletA2,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  stationA1 = await insertStation(tenantA, outletA1, "Bar A1");
  stationA1b = await insertStation(tenantA, outletA1, "Dapur A1");
  stationA2 = await insertStation(tenantA, outletA2, "Bar A2");
  stationB = await insertStation(tenantB, tenantB.outletId, "Bar B");

  const managerRoleA = await insertRole(
    tenantA.tenantId,
    "Pengelola Perangkat",
    ["device.registry.manage"],
  );
  const plainRoleA = await insertRole(tenantA.tenantId, "Tanpa Perangkat", [
    "floor.table.view",
  ]);
  const managerRoleB = await insertRole(
    tenantB.tenantId,
    "Pengelola Perangkat",
    ["device.registry.manage"],
  );
  managerTenantA = await member(
    tenantA,
    managerRoleA,
    { type: "tenant" },
    "Manajer A",
  );
  managerOutletA1 = await member(
    tenantA,
    managerRoleA,
    { type: "outlet", id: outletA1 },
    "Manajer Outlet A1",
  );
  noPermissionA = await member(
    tenantA,
    plainRoleA,
    { type: "tenant" },
    "Tanpa Izin",
  );
  const revokerRoleA = await insertRole(
    tenantA.tenantId,
    "Pencabut Perangkat",
    ["device.registry.manage", "device.registry.revoke"],
  );
  revokerA = await member(
    tenantA,
    revokerRoleA,
    { type: "tenant" },
    "Pencabut A",
  );
  managerTenantB = await member(
    tenantB,
    managerRoleB,
    { type: "tenant" },
    "Manajer B",
  );
});

// A fresh pair of stations per test: the registry may allow only one printer
// per station, so tests must not share them (the brief is silent on this).
beforeEach(async () => {
  stationA1 = await insertStation(tenantA, outletA1, `Bar A1 ${randomUUID()}`);
  stationA1b = await insertStation(
    tenantA,
    outletA1,
    `Dapur A1 ${randomUUID()}`,
  );
});

afterAll(async () => {
  setAuditWriter(null);
  // Edge and audit rows are append-only, so the isolated tenants stay in the
  // disposable database; give them a valid creator so the platform tenant
  // list still parses them.
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- happy path -----------------------------------------------------------------

describe("legend-2lp.6 printer registry CRUD", () => {
  it("creates a network receipt printer and returns it", async () => {
    const body = networkBody(outletA1, {
      label: "Kasir Depan",
      host: "10.1.2.3",
      port: 9101,
      paperWidth: 32,
    });
    const response = await http.create(managerTenantA, headersA, body);
    expect(response.status).toBe(201);
    const printer = response.body.data as PrinterDto;
    expect(printer).toMatchObject({
      label: "Kasir Depan",
      role: "receipt",
      transport: "network",
      host: "10.1.2.3",
      port: 9101,
      paperWidth: 32,
    });
    expect(sameId(printer.outletId, outletA1)).toBe(true);
    expect(printer.stationId ?? null).toBeNull();
    expect(printer.fallbackPrinterId ?? null).toBeNull();

    const row = await printerRow(printer.id);
    expect(row).toMatchObject({
      tenant_id: tenantA.tenantId,
      outlet_id: outletA1,
      label: "Kasir Depan",
      role: "receipt",
      transport: "network",
      host: "10.1.2.3",
      port: 9101,
      paper_width: 32,
    });
  });

  it("creates a USB printer with a device path and defaults the paper width to 48", async () => {
    const response = await http.create(managerTenantA, headersA, {
      outletId: outletA1,
      label: "USB Dapur",
      role: "receipt",
      transport: "usb",
      devicePath: "/dev/usb/lp0",
    });
    expect(response.status).toBe(201);
    const printer = response.body.data as PrinterDto;
    expect(printer).toMatchObject({
      transport: "usb",
      devicePath: "/dev/usb/lp0",
    });
    expect(printer.host ?? null).toBeNull();
    expect(printer.port ?? null).toBeNull();
    expect((await printerRow(printer.id))?.paper_width).toBe(48);
  });

  it("gets a printer by id", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Satu Printer" }),
    );
    const response = await http.get(managerTenantA, headersA, created.id);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ label: "Satu Printer" });
    expect(sameId(response.body.data.id, created.id)).toBe(true);
  });

  it("lists the printers of one outlet only", async () => {
    const a1 = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "List A1" }),
    );
    const a2 = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA2, { label: "List A2" }),
    );
    const response = await http.list(
      managerTenantA,
      headersA,
      `?outletId=${outletA1}`,
    );
    expect(response.status).toBe(200);
    const ids = (response.body.data as PrinterDto[]).map((p) => p.id);
    expect(ids.some((id) => sameId(id, a1.id))).toBe(true);
    expect(ids.some((id) => sameId(id, a2.id))).toBe(false);
  });

  it("edits label, host, port and paper width", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Lama" }),
    );
    const response = await http.patch(managerTenantA, headersA, created.id, {
      transport: "network", // assumed: connection fields travel with their transport
      label: "Baru",
      host: "172.16.4.9",
      port: 9102,
      paperWidth: 32,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      label: "Baru",
      host: "172.16.4.9",
      port: 9102,
      paperWidth: 32,
    });
    expect(await printerRow(created.id)).toMatchObject({
      label: "Baru",
      host: "172.16.4.9",
      port: 9102,
      paper_width: 32,
    });
  });

  it("sets and clears a fallback printer", async () => {
    const main = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    const backup = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { host: "192.168.1.51" }),
    );
    const set = await http.patch(managerTenantA, headersA, main.id, {
      fallbackPrinterId: backup.id,
    });
    expect(set.status).toBe(200);
    expect(sameId(set.body.data.fallbackPrinterId, backup.id)).toBe(true);
    expect((await printerRow(main.id))?.fallback_printer_id).toBe(
      dbId(backup.id),
    );

    const cleared = await http.patch(managerTenantA, headersA, main.id, {
      fallbackPrinterId: null,
    });
    expect(cleared.status).toBe(200);
    expect((await printerRow(main.id))?.fallback_printer_id).toBeNull();
  });

  it("creates a station printer that points back at its station", async () => {
    const response = await http.create(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(response.status).toBe(201);
    expect(sameId(response.body.data.stationId, stationA1)).toBe(true);
  });

  it("deletes a printer", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    const response = await http.remove(managerTenantA, headersA, created.id);
    expect([200, 204]).toContain(response.status);
    expect(await printerRow(created.id)).toBeUndefined();
    expect((await http.get(managerTenantA, headersA, created.id)).status).toBe(
      404,
    );
    const list = await http.list(
      managerTenantA,
      headersA,
      `?outletId=${outletA1}`,
    );
    expect(
      (list.body.data as PrinterDto[]).some((p) => sameId(p.id, created.id)),
    ).toBe(false);
  });

  it("an outlet-scoped manager manages printers of their own outlet", async () => {
    const created = await createPrinter(
      managerOutletA1,
      headersA,
      networkBody(outletA1, { label: "Dari manajer outlet" }),
    );
    const patched = await http.patch(managerOutletA1, headersA, created.id, {
      label: "Diubah manajer outlet",
    });
    expect(patched.status).toBe(200);
    expect((await http.get(managerOutletA1, headersA, created.id)).status).toBe(
      200,
    );
  });
});

// ---- permission and tenancy ------------------------------------------------------

describe("legend-2lp.6 permission and isolation", () => {
  it("refuses every route without device.registry.manage", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Tanpa izin" }),
    );
    const before = await printerCount(tenantA.tenantId);

    const list = await http.list(
      noPermissionA,
      headersA,
      `?outletId=${outletA1}`,
    );
    expect([403, 404]).toContain(list.status);
    expect([403, 404]).toContain(
      (await http.get(noPermissionA, headersA, created.id)).status,
    );
    expect([403, 404]).toContain(
      (await http.create(noPermissionA, headersA, networkBody(outletA1)))
        .status,
    );
    expect([403, 404]).toContain(
      (await http.patch(noPermissionA, headersA, created.id, { label: "x" }))
        .status,
    );
    expect([403, 404]).toContain(
      (await http.remove(noPermissionA, headersA, created.id)).status,
    );
    expect(await printerCount(tenantA.tenantId)).toBe(before);
    expect((await printerRow(created.id))?.label).toBe("Tanpa izin");
  });

  it("requires a signed-in session", async () => {
    const anonymous = agent(app);
    const response = await anonymous
      .get(`/api/printers?outletId=${outletA1}`)
      .set(headersA)
      .set(originHeader);
    expect(response.status).toBe(401);
  });

  it("another tenant cannot see, edit or delete a printer (404)", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Milik A" }),
    );
    // Tenant B's manager, on tenant B's host and on tenant A's host.
    for (const headers of [headersB, headersA]) {
      expect((await http.get(managerTenantB, headers, created.id)).status).toBe(
        404,
      );
      expect(
        (
          await http.patch(managerTenantB, headers, created.id, {
            label: "Dibajak",
          })
        ).status,
      ).toBe(404);
      expect(
        (await http.remove(managerTenantB, headers, created.id)).status,
      ).toBe(404);
    }
    expect((await printerRow(created.id))?.label).toBe("Milik A");
    // And not listed for tenant B.
    const list = await http.list(
      managerTenantB,
      headersB,
      `?outletId=${tenantB.outletId}`,
    );
    expect(list.status).toBe(200);
    expect(
      (list.body.data as PrinterDto[]).some((p) => sameId(p.id, created.id)),
    ).toBe(false);
  });

  it("cannot create a printer in another tenant's outlet", async () => {
    // Prove the route exists first, so the refusal below is not a missing route.
    await createPrinter(
      managerTenantB,
      headersB,
      networkBody(tenantB.outletId),
    );
    const before = await printerCount(tenantB.tenantId);
    const response = await http.create(
      managerTenantA,
      headersA,
      networkBody(tenantB.outletId),
    );
    expect([403, 404, 422]).toContain(response.status);
    expect(await printerCount(tenantB.tenantId)).toBe(before);
  });

  it("an outlet-scoped manager gets 404 for a printer of another outlet", async () => {
    const other = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA2, { label: "Outlet A2" }),
    );
    expect((await http.get(managerOutletA1, headersA, other.id)).status).toBe(
      404,
    );
    expect(
      (await http.patch(managerOutletA1, headersA, other.id, { label: "x" }))
        .status,
    ).toBe(404);
    expect(
      (await http.remove(managerOutletA1, headersA, other.id)).status,
    ).toBe(404);
    expect((await printerRow(other.id))?.label).toBe("Outlet A2");

    const list = await http.list(
      managerOutletA1,
      headersA,
      `?outletId=${outletA2}`,
    );
    expect([403, 404]).toContain(list.status);
    const create = await http.create(
      managerOutletA1,
      headersA,
      networkBody(outletA2),
    );
    expect([403, 404]).toContain(create.status);
  });

  it("an unknown printer id is 404", async () => {
    // Route must exist for a real printer first.
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    expect((await http.get(managerTenantA, headersA, created.id)).status).toBe(
      200,
    );
    expect(
      (await http.get(managerTenantA, headersA, randomUUID())).status,
    ).toBe(404);
  });
});

// ---- validation -----------------------------------------------------------------

describe("legend-2lp.6 validation", () => {
  // Each case first proves a valid create works (201), then that the bad one is
  // refused and stored nothing.
  async function expectRejected(body: Record<string, unknown>) {
    await createPrinter(managerTenantA, headersA, networkBody(outletA1));
    const before = await printerCount(tenantA.tenantId);
    const response = await http.create(managerTenantA, headersA, body);
    expect(rejected).toContain(response.status);
    expect(await printerCount(tenantA.tenantId)).toBe(before);
  }

  it.each([
    ["a public IP", "8.8.8.8"],
    ["loopback", "127.0.0.1"],
    ["link-local", "169.254.1.1"],
    ["a hostname", "printer.local"],
    ["an IP just outside 172.16/12", "172.32.0.1"],
  ])("refuses %s as host", async (_name, host) => {
    await expectRejected(networkBody(outletA1, { host }));
  });

  it.each([
    ["a port below 9100", 80],
    ["a port above 9102", 9103],
    ["port 0", 0],
    ["a non-integer port", 9100.5],
  ])("refuses %s", async (_name, port) => {
    await expectRejected(networkBody(outletA1, { port }));
  });

  it("refuses a network printer without host or port", async () => {
    await expectRejected({
      outletId: outletA1,
      label: "Tanpa alamat",
      role: "receipt",
      transport: "network",
    });
  });

  it.each([
    "/etc/passwd",
    "/dev/sda",
    "/dev/usb/lp",
    "/dev/lpx",
    "../dev/lp0",
    "/dev/usb/lp0/../../sda",
  ])("refuses device path %s", async (devicePath) => {
    await expectRejected({
      outletId: outletA1,
      label: "USB salah",
      role: "receipt",
      transport: "usb",
      devicePath,
    });
  });

  it("refuses a USB printer that also carries host and port", async () => {
    await expectRejected({
      outletId: outletA1,
      label: "USB campur",
      role: "receipt",
      transport: "usb",
      devicePath: "/dev/lp0",
      host: "192.168.1.5",
      port: 9100,
    });
  });

  it("refuses a paper width other than 32 or 48", async () => {
    await expectRejected(networkBody(outletA1, { paperWidth: 40 }));
  });

  it("refuses an unknown role, transport, or extra field", async () => {
    await expectRejected(networkBody(outletA1, { role: "kitchen" }));
    await expectRejected(networkBody(outletA1, { transport: "bluetooth" }));
    await expectRejected(networkBody(outletA1, { status: "online" }));
  });

  it("refuses an empty label and a missing outlet", async () => {
    await expectRejected(networkBody(outletA1, { label: "" }));
    const body = networkBody(outletA1);
    delete body.outletId;
    await expectRejected(body);
  });

  it("refuses a station on a receipt printer", async () => {
    await expectRejected(
      networkBody(outletA1, { role: "receipt", stationId: stationA1 }),
    );
  });

  it("allows a station printer without a station yet", async () => {
    const response = await http.create(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station" }),
    );
    expect(response.status).toBe(201);
    expect(response.body.data.stationId ?? null).toBeNull();
  });

  it("refuses a station that does not exist or belongs to another outlet or tenant", async () => {
    for (const stationId of [randomUUID(), stationA2, stationB]) {
      await createPrinter(managerTenantA, headersA, networkBody(outletA1));
      const before = await printerCount(tenantA.tenantId);
      const response = await http.create(
        managerTenantA,
        headersA,
        networkBody(outletA1, { role: "station", stationId }),
      );
      expect([400, 404, 422]).toContain(response.status);
      expect(await printerCount(tenantA.tenantId)).toBe(before);
    }
  });

  it("refuses a fallback printer from another outlet or tenant", async () => {
    const sameOutlet = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    const otherOutlet = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA2),
    );
    const otherTenant = await createPrinter(
      managerTenantB,
      headersB,
      networkBody(tenantB.outletId),
    );
    for (const fallback of [otherOutlet.id, otherTenant.id, randomUUID()]) {
      const onCreate = await http.create(
        managerTenantA,
        headersA,
        networkBody(outletA1, { fallbackPrinterId: fallback }),
      );
      expect([400, 404, 422]).toContain(onCreate.status);
      const onPatch = await http.patch(
        managerTenantA,
        headersA,
        sameOutlet.id,
        { fallbackPrinterId: fallback },
      );
      expect([400, 404, 422]).toContain(onPatch.status);
    }
    expect((await printerRow(sameOutlet.id))?.fallback_printer_id).toBeNull();
  });

  it("refuses a printer as its own fallback", async () => {
    const printer = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    const response = await http.patch(managerTenantA, headersA, printer.id, {
      fallbackPrinterId: printer.id,
    });
    expect(rejected).toContain(response.status);
    expect((await printerRow(printer.id))?.fallback_printer_id).toBeNull();
  });

  it("refuses edits that break the transport rules, leaving the row unchanged", async () => {
    const printer = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Utuh" }),
    );
    for (const patch of [
      { host: "8.8.8.8" },
      { port: 80 },
      { paperWidth: 40 },
      { devicePath: "/dev/usb/lp1" }, // network printer with a path
      { role: "receipt", stationId: stationA1 },
      { outletId: outletA2 }, // outlet is immutable
      { id: randomUUID() },
      { label: "" },
    ]) {
      const response = await http.patch(
        managerTenantA,
        headersA,
        printer.id,
        patch,
      );
      expect(rejected).toContain(response.status);
    }
    expect(await printerRow(printer.id)).toMatchObject({
      label: "Utuh",
      host: "192.168.1.50",
      port: 9100,
      paper_width: 48,
      outlet_id: outletA1,
    });
  });
});

// ---- delete rules ---------------------------------------------------------------

describe("legend-2lp.6 delete rules", () => {
  it("answers 409 while another printer uses it as fallback, then allows it once released", async () => {
    const backup = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { host: "192.168.1.60" }),
    );
    const main = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { fallbackPrinterId: backup.id }),
    );
    const blocked = await http.remove(managerTenantA, headersA, backup.id);
    expect(blocked.status).toBe(409);
    expect(await printerRow(backup.id)).toBeDefined();
    expect((await deviceRow(backup.id))?.status).toBe("active");

    expect(
      (
        await http.patch(managerTenantA, headersA, main.id, {
          fallbackPrinterId: null,
        })
      ).status,
    ).toBe(200);
    const allowed = await http.remove(managerTenantA, headersA, backup.id);
    expect([200, 204]).toContain(allowed.status);
    expect(await printerRow(backup.id)).toBeUndefined();
  });

  it("answers 409 for a printer that has print jobs", async () => {
    const printer = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key)
         VALUES ($1, $2, $3, $4::uuid, 'receipt', '\\x1b40', $5)`,
        [
          randomUUID(),
          tenantA.tenantId,
          outletA1,
          dbId(printer.id),
          `prn-${randomUUID()}`,
        ],
      ),
    );
    const response = await http.remove(managerTenantA, headersA, printer.id);
    expect(response.status).toBe(409);
    expect(await printerRow(printer.id)).toBeDefined();
    expect((await deviceRow(printer.id))?.status).toBe("active");
  });
});

// ---- devices registry link ------------------------------------------------------

describe("legend-2lp.6 devices registry link", () => {
  it("creates a linked devices row of type printer with the same id", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, {
        label: "Terhubung",
        role: "station",
        stationId: stationA1,
      }),
    );
    const device = await deviceRow(created.id);
    expect(device).toBeDefined();
    expect(device).toMatchObject({
      tenant_id: tenantA.tenantId,
      outlet_id: outletA1,
      type: "printer",
      label: "Terhubung",
      station_id: stationA1,
      status: "active",
    });
    expect(device?.revoked_at).toBeNull();
  });

  it("keeps the device label and station in sync on edit", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { label: "Sebelum", role: "station" }),
    );
    expect((await deviceRow(created.id))?.station_id).toBeNull();
    const response = await http.patch(managerTenantA, headersA, created.id, {
      label: "Sesudah",
      stationId: stationA1,
    });
    expect(response.status).toBe(200);
    expect(await deviceRow(created.id)).toMatchObject({
      label: "Sesudah",
      station_id: stationA1,
      status: "active",
    });
  });

  it("revokes the linked device when the printer is deleted", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    expect((await deviceRow(created.id))?.status).toBe("active");
    const response = await http.remove(managerTenantA, headersA, created.id);
    expect([200, 204]).toContain(response.status);
    const device = await deviceRow(created.id);
    expect(device?.status).toBe("revoked");
    expect(device?.revoked_at).not.toBeNull();
  });

  it("writes no devices row when the create is refused", async () => {
    await createPrinter(managerTenantA, headersA, networkBody(outletA1));
    const { rows: before } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND type = 'printer'",
      [tenantA.tenantId],
    );
    const response = await http.create(
      managerTenantA,
      headersA,
      networkBody(outletA1, { host: "8.8.8.8" }),
    );
    expect(rejected).toContain(response.status);
    const { rows: after } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND type = 'printer'",
      [tenantA.tenantId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

// ---- stations.printer_device_id -------------------------------------------------

describe("legend-2lp.6 stations.printer_device_id", () => {
  it("sets the station's printer when a station printer is created", async () => {
    expect(await stationPrinter(stationA1b)).toBeNull();
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1b }),
    );
    expect(await stationPrinter(stationA1b)).toBe(dbId(created.id));
  });

  it("moves the link when the printer is assigned to another station", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(await stationPrinter(stationA1)).toBe(dbId(created.id));
    const response = await http.patch(managerTenantA, headersA, created.id, {
      stationId: stationA1b,
    });
    expect(response.status).toBe(200);
    expect(await stationPrinter(stationA1b)).toBe(dbId(created.id));
    expect(await stationPrinter(stationA1)).toBeNull();
  });

  it("clears the station's printer when the station is unassigned", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(await stationPrinter(stationA1)).toBe(dbId(created.id));
    const response = await http.patch(managerTenantA, headersA, created.id, {
      stationId: null,
    });
    expect(response.status).toBe(200);
    expect(await stationPrinter(stationA1)).toBeNull();
    expect((await deviceRow(created.id))?.station_id).toBeNull();
  });

  it("clears the station's printer when the role changes to receipt", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(await stationPrinter(stationA1)).toBe(dbId(created.id));
    const response = await http.patch(managerTenantA, headersA, created.id, {
      role: "receipt",
      stationId: null,
    });
    expect(response.status).toBe(200);
    expect(await stationPrinter(stationA1)).toBeNull();
  });

  it("clears the station's printer when the printer is deleted", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(await stationPrinter(stationA1)).toBe(dbId(created.id));
    const response = await http.remove(managerTenantA, headersA, created.id);
    expect([200, 204]).toContain(response.status);
    expect(await stationPrinter(stationA1)).toBeNull();
  });

  it("does not touch the station when a create is refused", async () => {
    await createPrinter(managerTenantA, headersA, networkBody(outletA1));
    const before = await stationPrinter(stationA1b);
    const response = await http.create(
      managerTenantA,
      headersA,
      networkBody(outletA1, {
        role: "station",
        stationId: stationA1b,
        host: "8.8.8.8",
      }),
    );
    expect(rejected).toContain(response.status);
    expect(await stationPrinter(stationA1b)).toBe(before);
  });
});

// ---- review follow-ups ------------------------------------------------------------

describe("legend-2lp.6 review follow-ups", () => {
  it("does not rebind the station when a revoked printer device is edited", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    expect(await stationPrinter(stationA1)).toBe(dbId(created.id));
    const revoke = await revokerA.client
      .post(`/api/devices/${encodeURIComponent(dbId(created.id))}/revoke`)
      .set(headersA)
      .set(originHeader)
      .send({ reason: "Printer dicabut", idempotencyKey: randomUUID() });
    expect(revoke.status).toBe(200);
    expect((await deviceRow(created.id))?.status).toBe("revoked");
    // Assumption: revoking the device unbinds the station.
    expect(await stationPrinter(stationA1)).toBeNull();

    // The edit itself may succeed or be refused; it must not rebind.
    const patch = await http.patch(managerTenantA, headersA, created.id, {
      label: "Nama baru setelah dicabut",
    });
    expect([200, 404, 409, 422]).toContain(patch.status);
    expect(await stationPrinter(stationA1)).toBeNull();
    expect((await deviceRow(created.id))?.status).toBe("revoked");
  });

  it("refuses a second station printer on an already bound station (409) and keeps the first binding", async () => {
    const first = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1 }),
    );
    const before = await printerCount(tenantA.tenantId);
    const second = await http.create(
      managerTenantA,
      headersA,
      networkBody(outletA1, {
        role: "station",
        stationId: stationA1,
        host: "192.168.1.77",
      }),
    );
    expect(second.status).toBe(409);
    expect(await printerCount(tenantA.tenantId)).toBe(before);
    expect(await stationPrinter(stationA1)).toBe(dbId(first.id));

    // Same rule when an existing printer is moved onto the bound station.
    const other = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { role: "station", stationId: stationA1b }),
    );
    const move = await http.patch(managerTenantA, headersA, other.id, {
      stationId: stationA1,
    });
    expect(move.status).toBe(409);
    expect(await stationPrinter(stationA1)).toBe(dbId(first.id));
    expect(await stationPrinter(stationA1b)).toBe(dbId(other.id));
  });

  it("ends an open training period when the printer is deleted", async () => {
    const created = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO device_training_periods (tenant_id, outlet_id, device_id, started_at)
         VALUES ($1, $2, $3::uuid, now() - interval '1 hour')`,
        [tenantA.tenantId, outletA1, dbId(created.id)],
      ),
    );
    const response = await http.remove(managerTenantA, headersA, created.id);
    expect([200, 204]).toContain(response.status);
    const { rows } = await owner.query<{ ended_at: Date | null }>(
      "SELECT ended_at FROM device_training_periods WHERE device_id = $1::uuid",
      [dbId(created.id)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at).not.toBeNull();
  });

  it("refuses a fallback cycle (A -> B, then B -> A)", async () => {
    const a = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1),
    );
    const b = await createPrinter(
      managerTenantA,
      headersA,
      networkBody(outletA1, { host: "192.168.1.52" }),
    );
    const first = await http.patch(managerTenantA, headersA, a.id, {
      fallbackPrinterId: b.id,
    });
    expect(first.status).toBe(200);
    const cycle = await http.patch(managerTenantA, headersA, b.id, {
      fallbackPrinterId: a.id,
    });
    // Brief asked for 422; the API's validation errors are 400 VALIDATION_ERROR.
    expect(rejected).toContain(cycle.status);
    expect((await printerRow(b.id))?.fallback_printer_id).toBeNull();
    expect((await printerRow(a.id))?.fallback_printer_id).toBe(dbId(b.id));
  });
});
