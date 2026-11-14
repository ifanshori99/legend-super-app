// Fail-first tests for the `ops.checklist.manage` permission (bead legend-wg0g,
// WS-14). Checklist template authoring (POST/PATCH /api/operations/
// checklist-templates) was guarded by `ops.checklist.complete`, which the
// facility attendant holds. The new permission is held by owner,
// outlet_manager and kitchen_lead only, and the template write routes need it.
// Written from the bead text and the shared catalog/validators, not from the
// route code.
//
// ASSUMPTIONS:
// - Completing a checklist run keeps `ops.checklist.complete`; only template
//   authoring moves to `manage`. So a role holding `manage` alone can author a
//   template (it does not also need `complete`).
// - The catalog entry carries no sensitivity tag (like its `ops.*` siblings);
//   the test does not pin tags.
// - Denial is 403 (as in operations-checklist.test.ts), unauthenticated is 401.
// - Role templates are applied through their shared permission lists
//   (`roleTemplate(key).permissions`) on custom roles, so the HTTP part
//   exercises the guard and does not depend on a DB backfill of the seeded
//   template roles.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  ROLE_TEMPLATES,
  isPermissionCode,
  roleTemplate,
} from "@starter/shared/access";
import { MESSAGE_KEYS, createTranslator } from "@starter/shared/i18n";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const CODE = "ops.checklist.manage" as const;
const TEMPLATE_PATH = "/api/operations/checklist-templates";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdTemplateIds: string[] = [];

type Session = { client: ReturnType<typeof agent>; userId: string };

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

/** A signed-in user holding exactly `permissions` on outlet A. */
async function userWith(
  label: string,
  permissions: string[],
): Promise<Session> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant","outlet"]')`,
    [
      roleId,
      tenant.id,
      `Checklist manage test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [tenant.id, userId, roleId, outletA.id],
  );
  return { client, userId };
}

const key = () => `legend-wg0g-${randomUUID()}`;

function templateInput(name: string) {
  return {
    outletId: outletA.id,
    name,
    type: "opening",
    items: [{ label: "Suhu chiller", requiredEvidence: ["number"] }],
    schedule: {
      shiftTemplateId: null,
      stationId: null,
      zoneId: null,
      dueTime: "08:00",
    },
    roleId: null,
    idempotencyKey: key(),
  };
}

function postTemplate(who: Session, name: string) {
  return who.client
    .post(TEMPLATE_PATH)
    .set(originHeader)
    .send(templateInput(name));
}

function patchTemplate(
  who: Session,
  template: { id: string; updatedAt: string },
  name: string,
) {
  return who.client
    .patch(`${TEMPLATE_PATH}/${template.id}`)
    .set(originHeader)
    .send({
      name,
      expectedUpdatedAt: template.updatedAt,
      idempotencyKey: key(),
    });
}

let author: Session; // holds manage (+ complete) and seeds the templates
let existing: { id: string; updatedAt: string };

beforeAll(async () => {
  author = await userWith("Checklist author", ["ops.checklist.complete", CODE]);
  const response = await postTemplate(author, "Checklist dasar legend-wg0g");
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  existing = response.body.data;
  createdTemplateIds.push(existing.id);
});

afterAll(async () => {
  await asTenant(async (client) => {
    if (createdTemplateIds.length > 0)
      await client.query(
        "DELETE FROM ops_checklist_templates WHERE id = ANY($1)",
        [createdTemplateIds],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-wg0g-%'",
      [tenant.id],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Checklist manage test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("legend-wg0g ops.checklist.manage in the permission catalog", () => {
  it("is a registered permission code", () => {
    expect(PERMISSION_CODES).toContain(CODE);
    expect(isPermissionCode(CODE)).toBe(true);
    expect(PERMISSION_CATALOG.some((p) => p.code === CODE)).toBe(true);
  });

  it("is a different permission from ops.checklist.complete", () => {
    expect(PERMISSION_CODES).toContain("ops.checklist.complete");
    expect(CODE).not.toBe("ops.checklist.complete");
  });

  it("has an Indonesian label that resolves", () => {
    const labelKey = `access.permission.${CODE}`;
    expect(MESSAGE_KEYS).toContain(labelKey);
    const label = createTranslator()(labelKey as never);
    expect(label).not.toBe(labelKey);
    expect(label.trim().length).toBeGreaterThan(0);
  });

  it.each(["owner", "outlet_manager", "kitchen_lead"] as const)(
    "%s template holds it",
    (templateKey) => {
      expect(roleTemplate(templateKey).permissions).toContain(CODE);
    },
  );

  it("is held by no other role template, and not by facility_attendant", () => {
    expect(roleTemplate("facility_attendant").permissions).not.toContain(CODE);
    const holders = ROLE_TEMPLATES.filter((t) =>
      (t.permissions as readonly string[]).includes(CODE),
    )
      .map((t) => t.key)
      .sort();
    expect(holders).toEqual(["kitchen_lead", "outlet_manager", "owner"]);
  });

  it("keeps ops.checklist.complete on facility_attendant for running checklists", () => {
    expect(roleTemplate("facility_attendant").permissions).toContain(
      "ops.checklist.complete",
    );
  });
});

describe("legend-wg0g checklist template routes need ops.checklist.manage", () => {
  it("rejects POST from a role holding only ops.checklist.complete", async () => {
    const who = await userWith("Complete only", ["ops.checklist.complete"]);
    const response = await postTemplate(who, "Ditolak complete-only");
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("rejects PATCH from a role holding only ops.checklist.complete", async () => {
    const who = await userWith("Complete only patch", [
      "ops.checklist.complete",
    ]);
    const response = await patchTemplate(who, existing, "Ubah ditolak");
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("rejects POST and PATCH from the facility_attendant permission set", async () => {
    const who = await userWith(
      "Facility attendant",
      roleTemplate("facility_attendant").permissions as string[],
    );
    const created = await postTemplate(who, "Ditolak attendant");
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    const patched = await patchTemplate(who, existing, "Ubah attendant");
    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
  });

  it("lets a role holding only ops.checklist.manage create and edit a template", async () => {
    const who = await userWith("Manage only", [CODE]);
    const created = await postTemplate(who, "Dibuat manage-only");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createdTemplateIds.push(created.body.data.id as string);
    const patched = await patchTemplate(
      who,
      created.body.data,
      "Diubah manage-only",
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.data.name).toBe("Diubah manage-only");
  });

  it.each(["owner", "outlet_manager", "kitchen_lead"] as const)(
    "lets the %s permission set create and edit a template",
    async (templateKey) => {
      const who = await userWith(
        `Template ${templateKey}`,
        roleTemplate(templateKey).permissions as string[],
      );
      const created = await postTemplate(who, `Dibuat ${templateKey}`);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      createdTemplateIds.push(created.body.data.id as string);
      const patched = await patchTemplate(
        who,
        created.body.data,
        `Diubah ${templateKey}`,
      );
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    },
  );

  it("answers 401 to POST and PATCH without a session", async () => {
    const anon = agent(app);
    const created = await anon
      .post(TEMPLATE_PATH)
      .set(originHeader)
      .send(templateInput("Tanpa sesi"));
    expect(created.status).toBe(401);
    const patched = await anon
      .patch(`${TEMPLATE_PATH}/${existing.id}`)
      .set(originHeader)
      .send({
        name: "Tanpa sesi",
        expectedUpdatedAt: existing.updatedAt,
        idempotencyKey: key(),
      });
    expect(patched.status).toBe(401);
  });
});
