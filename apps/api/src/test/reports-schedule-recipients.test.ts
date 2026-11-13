// Fail-first tests for GET /api/reports/schedule-recipients (WS-11, bead
// legend-rmvu). Written from the contract in
// packages/shared/src/dashboard/builder.ts (listReportScheduleRecipientsEndpoint,
// reportScheduleRecipientPageSchema), never from the route code. Everything
// goes over HTTP so authentication, permission and tenant isolation are part
// of what is pinned.
//
// Contract text: "The server lists only users of the caller's tenant who hold
// the permissions of reports they may schedule; never an external address."
// Item = { userId, name, roleName }; the email never reaches the client.
//
// ASSUMPTIONS (the contract does not pin these down):
// - "Holds the permissions of reports they may schedule" = holds at least one
//   `report.*` permission. A tenant user with only a floor permission is not a
//   recipient.
// - `roleName` is the display name of the role the user holds in the tenant.
// - The caller needs a report permission to open the picker: unauthenticated
//   answers 401, a signed-in user with no report permission answers 403.
// - A signed-in user of another tenant who reaches this tenant's host gets 403,
//   or a 200 that carries none of this tenant's users; never this tenant's list.
// - An out-of-range `limit` is rejected with 400 or 422 (the project maps zod
//   errors to 422).
// - The caller holds a report permission, so the caller appears in its own list.
//
// Every run builds its own two tenants, so concurrent suites never touch these
// rows.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { reportScheduleRecipientPageSchema } from "@starter/shared/dashboard";
import { createApp } from "../app";
import { agent, setRole, signUp, verifySessionMfa } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type Client = ReturnType<typeof agent>;
type Member = {
  client: Client;
  userId: string;
  email: string;
  name: string;
  roleName: string | null;
};
type World = {
  tenantId: string;
  host: string;
  caller: Member; // report.sales.view, can open the picker
  salesRecipient: Member; // report.sales.view
  financeRecipient: Member; // report.financial.view
  floorOnly: Member; // floor permission only: never a recipient
  nobody: Member; // signed up, no assignment in the tenant
  all: Member[];
};

const SALES_ROLE = "Penerima Penjualan uji";
const FINANCE_ROLE = "Penerima Keuangan uji";
const FLOOR_ROLE = "Staf Lantai uji";

let app: Express;
let a: World;
let b: World;

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, tenantId, name, JSON.stringify(permissions)],
  );
  return roleId;
}

async function member(
  tenantId: string,
  name: string,
  role: { id: string; name: string } | null,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, name);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  if (role !== null)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, userId, role.id],
    );
  await verifySessionMfa(email);
  return { client, userId, email, name, roleName: role?.name ?? null };
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `rsr-${label}-${randomUUID().slice(0, 6)}`,
  );
  const sales = {
    id: await insertRole(tenant.tenantId, SALES_ROLE, ["report.sales.view"]),
    name: SALES_ROLE,
  };
  const finance = {
    id: await insertRole(tenant.tenantId, FINANCE_ROLE, [
      "report.financial.view",
    ]),
    name: FINANCE_ROLE,
  };
  const floor = {
    id: await insertRole(tenant.tenantId, FLOOR_ROLE, ["floor.table.view"]),
    name: FLOOR_ROLE,
  };
  const caller = await member(tenant.tenantId, `Pemanggil ${label}`, sales);
  const salesRecipient = await member(
    tenant.tenantId,
    `Penjualan ${label}`,
    sales,
  );
  const financeRecipient = await member(
    tenant.tenantId,
    `Keuangan ${label}`,
    finance,
  );
  const floorOnly = await member(tenant.tenantId, `Lantai ${label}`, floor);
  const nobody = await member(tenant.tenantId, `Tanpa peran ${label}`, null);
  return {
    tenantId: tenant.tenantId,
    host: tenant.hostname,
    caller,
    salesRecipient,
    financeRecipient,
    floorOnly,
    nobody,
    all: [caller, salesRecipient, financeRecipient, floorOnly, nobody],
  };
}

const PATH = "/api/reports/schedule-recipients";

const listAs = (who: Member | null, host: string, query = "") =>
  (who?.client ?? agent(app)).get(`${PATH}${query}`).set("Host", host);

/** Walks every page and returns the parsed items. */
async function allRecipients(who: Member, host: string, limit?: number) {
  const items: { userId: string; name: string; roleName: string }[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await listAs(who, host, `?${query.toString()}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const page = reportScheduleRecipientPageSchema.parse(response.body);
    if (limit !== undefined)
      expect(page.data.length).toBeLessThanOrEqual(limit);
    items.push(...page.data);
    if (page.meta.nextCursor === null) return items;
    cursor = page.meta.nextCursor;
  }
  throw new Error("recipient pagination did not terminate");
}

beforeAll(async () => {
  app = createApp();
  a = await makeWorld("a");
  b = await makeWorld("b");
});

afterAll(async () => {
  const users = [...a.all, ...b.all].map((m) => m.userId);
  await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
    users,
  ]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
});

describe("legend-rmvu GET /api/reports/schedule-recipients", () => {
  it("lists the tenant users holding a report permission, as {userId, name, roleName}", async () => {
    const response = await listAs(a.caller, a.host);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const page = reportScheduleRecipientPageSchema.parse(response.body);
    const byId = new Map(page.data.map((item) => [item.userId, item]));

    expect(byId.get(a.salesRecipient.userId)).toEqual({
      userId: a.salesRecipient.userId,
      name: a.salesRecipient.name,
      roleName: SALES_ROLE,
    });
    expect(byId.get(a.financeRecipient.userId)).toEqual({
      userId: a.financeRecipient.userId,
      name: a.financeRecipient.name,
      roleName: FINANCE_ROLE,
    });
    expect(byId.has(a.caller.userId)).toBe(true);
  });

  it("leaves out tenant users without any report permission", async () => {
    const items = await allRecipients(a.caller, a.host);
    const ids = new Set(items.map((item) => item.userId));
    expect(ids.has(a.floorOnly.userId)).toBe(false);
    expect(ids.has(a.nobody.userId)).toBe(false);
  });

  it("never exposes an email address to the client", async () => {
    const response = await listAs(a.caller, a.host);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const raw = JSON.stringify(response.body);
    for (const m of [...a.all, ...b.all]) expect(raw).not.toContain(m.email);
    expect(raw).not.toMatch(/"email"/);
    expect(raw).not.toContain("@example.com");
  });

  it("pages with limit/cursor without repeating or dropping a recipient", async () => {
    const first = await listAs(a.caller, a.host, "?limit=1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstPage = reportScheduleRecipientPageSchema.parse(first.body);
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.meta.nextCursor).not.toBeNull();

    const paged = await allRecipients(a.caller, a.host, 1);
    const pagedIds = paged.map((item) => item.userId);
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
    const whole = await allRecipients(a.caller, a.host);
    expect(new Set(pagedIds)).toEqual(new Set(whole.map((i) => i.userId)));
    expect(pagedIds.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects an out-of-range limit", async () => {
    for (const limit of ["0", "-1", "100000"]) {
      const response = await listAs(a.caller, a.host, `?limit=${limit}`);
      expect([400, 422], `limit=${limit}`).toContain(response.status);
    }
  });

  it("isolates tenants: only the caller's tenant users are listed, both ways", async () => {
    const aIds = new Set(
      (await allRecipients(a.caller, a.host)).map((i) => i.userId),
    );
    const bIds = new Set(
      (await allRecipients(b.caller, b.host)).map((i) => i.userId),
    );
    for (const m of b.all)
      expect(aIds.has(m.userId), `B ${m.name} in A`).toBe(false);
    for (const m of a.all)
      expect(bIds.has(m.userId), `A ${m.name} in B`).toBe(false);
    expect(aIds.has(a.salesRecipient.userId)).toBe(true);
    expect(bIds.has(b.salesRecipient.userId)).toBe(true);
  });

  it("does not hand tenant A's list to a user of tenant B on A's host", async () => {
    const response = await listAs(b.caller, a.host);
    expect([200, 403], JSON.stringify(response.body)).toContain(
      response.status,
    );
    if (response.status === 200) {
      const page = reportScheduleRecipientPageSchema.parse(response.body);
      const aIds = new Set(a.all.map((m) => m.userId));
      for (const item of page.data) expect(aIds.has(item.userId)).toBe(false);
    }
  });

  it("answers 401 without a session", async () => {
    const response = await listAs(null, a.host);
    expect(response.status).toBe(401);
  });

  it("answers 403 to a signed-in user with no report permission", async () => {
    for (const who of [a.floorOnly, a.nobody]) {
      const response = await listAs(who, a.host);
      expect(response.status, who.name).toBe(403);
    }
  });
});
