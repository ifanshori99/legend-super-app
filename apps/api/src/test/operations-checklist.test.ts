// Daily-operations checklist, food-safety and prep HTTP API (PRD v1.7 §3
// F41/F45, §6 L; OPS-01, OPS-02, OPS-03; TEN-01..03; bead legend-btha). Runs
// the real Express app, Better Auth, the RBAC resolver and PostgreSQL against
// the seeded Cafe Legend tenant. Needs `operationsRouter` mounted at
// /api/operations.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4Schema,
  outletIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createChecklistRun,
  createChecklistTemplate,
  createPrepLabel,
  createTemperatureLog,
  getChecklistRun,
  listChecklistTemplates,
  listPrepLabels,
  updateChecklistTemplate,
} from "@starter/shared/operations";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { recordChecklistItemResult as recordChecklistItemResultService } from "../services/operations-checklist.service.ts";
import { operationsFingerprint } from "../services/operations-idempotency.ts";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdTemplateIds: string[] = [];
const createdRunIds: string[] = [];
const createdPrepLabelIds: string[] = [];
const createdMediaIds: string[] = [];

// Fixture rows the food-safety and prep endpoints read (equipment threshold,
// inventory item, stock location and batch); inserted as the seeded tenant.
const equipmentId = randomUUID();
const uomId = randomUUID();
const inventoryItemId = randomUUID();
const locationId = randomUUID();
const batchId = randomUUID();
const uomCode = `BTH${randomUUID().slice(0, 4).toUpperCase()}`;

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

async function signedIn(name: string): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

/** A tenant-scoped owner: holds every `ops.*` permission on both outlets. */
async function ownerClient(): Promise<Session> {
  const session = await signedIn("Operations Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 day', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, session.userId],
  );
  return session;
}

/** An outlet-B-only operations role: the caller cannot reach outlet A. */
async function outletClient(outletId: string): Promise<Session> {
  const session = await signedIn("Operations Outlet B");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Operations API test ${roleId.slice(0, 8)}`,
      JSON.stringify([
        "ops.checklist.complete",
        "ops.checklist.manage",
        "ops.food_safety.log",
        "ops.prep.manage",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [tenant.id, session.userId, roleId, outletId],
  );
  return session;
}

/**
 * A stored evidence object (photo/signature) in one outlet of the tenant.
 * Defaults to what the upload endpoint leaves for checklist evidence: kind
 * `checklist_evidence`, uploaded and owned by the test actor (`staff`), not yet
 * attached to any document (legend-mg2bz). Overrides model the bad cases.
 */
async function storedMedia(
  outletId: string = outletA.id,
  options: {
    sourceKind?: string | null;
    uploadedBy?: string;
    sourceId?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const sourceKind =
    options.sourceKind === undefined
      ? "checklist_evidence"
      : options.sourceKind;
  const uploader = options.uploadedBy ?? staff.userId;
  const sourceId = options.sourceId ?? null;
  await asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, source_kind, source_id, owner_user_id, uploaded_by)
       VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5, $6, $7, $7)`,
      [
        tenant.id,
        outletId,
        id,
        `legend-btha/${id}.webp`,
        sourceKind,
        sourceId,
        uploader,
      ],
    ),
  );
  createdMediaIds.push(id);
  return id;
}

/** The source link the stored object carries now. */
async function mediaSource(mediaId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{
      source_kind: string | null;
      source_id: string | null;
    }>(
      "SELECT source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenant.id, mediaId],
    );
    return rows[0];
  });
}

/** A fresh idempotency key: the tenant-wide key space is shared. */
const key = () => `legend-btha-${randomUUID()}`;

let staff: Session;
let baseTemplateId = "";

beforeAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO equipment (id, tenant_id, outlet_id, name, category, temperature_threshold)
       VALUES ($1, $2, $3, 'Chiller legend-btha', 'chiller', $4)`,
      [
        equipmentId,
        tenant.id,
        outletA.id,
        JSON.stringify({ minCelsius: "2.0000", maxCelsius: "8.0000" }),
      ],
    );
    await client.query(
      "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Kilogram')",
      [uomId, tenant.id, uomCode],
    );
    await client.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
       VALUES ($1, $2, 'Susu segar legend-btha', 'Bahan Baku', 'raw_material', $3)`,
      [inventoryItemId, tenant.id, uomId],
    );
    await client.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Chiller legend-btha', 'chiller')`,
      [locationId, tenant.id, outletA.id],
    );
    await client.query(
      `INSERT INTO stock_batches (id, tenant_id, outlet_id, location_id, inventory_item_id, batch_code)
       VALUES ($1, $2, $3, $4, $5, 'BTH-001')`,
      [batchId, tenant.id, outletA.id, locationId, inventoryItemId],
    );
  });
  staff = await ownerClient();
  const response = await staff.client
    .post("/api/operations/checklist-templates")
    .set(originHeader)
    .send({
      ...templateInput({ name: "Checklist buka legend-btha" }),
      idempotencyKey: key(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  baseTemplateId = response.body.data.id as string;
  createdTemplateIds.push(baseTemplateId);
});

afterAll(async () => {
  await asTenant(async (client) => {
    if (createdPrepLabelIds.length > 0)
      await client.query("DELETE FROM prep_labels WHERE id = ANY($1)", [
        createdPrepLabelIds,
      ]);
    await client.query(
      "DELETE FROM prep_item_settings WHERE tenant_id = $1 AND inventory_item_id = $2",
      [tenant.id, inventoryItemId],
    );
    await client.query("DELETE FROM temperature_logs WHERE equipment_id = $1", [
      equipmentId,
    ]);
    if (createdRunIds.length > 0) {
      await client.query(
        `DELETE FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->'payload'->>'runId' = ANY($2)`,
        [tenant.id, createdRunIds],
      );
      await client.query("DELETE FROM ops_checklist_runs WHERE id = ANY($1)", [
        createdRunIds,
      ]);
    }
    if (createdTemplateIds.length > 0)
      await client.query(
        "DELETE FROM ops_checklist_templates WHERE id = ANY($1)",
        [createdTemplateIds],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-btha-%'",
      [tenant.id],
    );
    if (createdMediaIds.length > 0)
      await client.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdMediaIds],
      );
    await client.query("DELETE FROM equipment WHERE id = $1", [equipmentId]);
    await client.query("DELETE FROM stock_batches WHERE id = $1", [batchId]);
    await client.query("DELETE FROM stock_locations WHERE id = $1", [
      locationId,
    ]);
    await client.query("DELETE FROM inventory_items WHERE id = $1", [
      inventoryItemId,
    ]);
    await client.query("DELETE FROM uoms WHERE id = $1", [uomId]);
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Operations API test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

// --------------------------------------------------------------- HTTP helpers

function templateInput(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outletA.id,
    name: "Checklist legend-btha",
    type: "opening",
    items: [
      { label: "Suhu chiller", requiredEvidence: ["number"] },
      { label: "Foto area bar", requiredEvidence: ["photo"] },
      { label: "Tanda tangan supervisor", requiredEvidence: ["signature"] },
    ],
    schedule: {
      shiftTemplateId: null,
      stationId: null,
      zoneId: null,
      dueTime: "08:00",
    },
    roleId: null,
    ...overrides,
  };
}

/** Creates a template over HTTP and returns the contract object. */
async function postTemplate(
  session: Session,
  overrides: Record<string, unknown> = {},
) {
  const response = await session.client
    .post("/api/operations/checklist-templates")
    .set(originHeader)
    .send({ ...templateInput(overrides), idempotencyKey: key() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  createChecklistTemplate.response.parse(response.body);
  createdTemplateIds.push(response.body.data.id as string);
  return response.body.data;
}

/** Creates a run over HTTP and returns the contract object. */
async function postRun(
  session: Session,
  templateId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await session.client
    .post("/api/operations/checklist-runs")
    .set(originHeader)
    .send({
      outletId: outletA.id,
      templateId,
      shiftDate: "2030-01-15",
      shiftTemplateId: null,
      assignedTo: session.userId,
      ...overrides,
      idempotencyKey: key(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  createChecklistRun.response.parse(response.body);
  createdRunIds.push(response.body.data.id as string);
  return response.body.data;
}

async function postTransition(session: Session, runId: string, action: string) {
  return session.client
    .post(`/api/operations/checklist-runs/${runId}/transition`)
    .set(originHeader)
    .send({ action, idempotencyKey: key() });
}

async function postResult(
  session: Session,
  runId: string,
  itemId: string,
  evidence: Record<string, unknown> = {},
) {
  return session.client
    .post(`/api/operations/checklist-runs/${runId}/items/${itemId}/result`)
    .set(originHeader)
    .send({
      status: "done",
      numberValue: null,
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      ...evidence,
      idempotencyKey: key(),
    });
}

/** One run's snapshot item id, by its label. */
function itemIdOf(
  run: { items: { id: string; label: string }[] },
  label: string,
) {
  const item = run.items.find((entry) => entry.label === label);
  if (!item) throw new Error(`No checklist item labelled ${label}`);
  return item.id;
}

/** Starts a run, the state every answer requires. */
async function startRun(session: Session, runId: string) {
  const started = await postTransition(session, runId, "start");
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.data.status).toBe("in_progress");
}

type RunEvent = {
  name: string;
  destination: string;
  payload: { runId: string; failedItemIds: string[] };
};

/** Outbox rows raised for one run (found through the payload, not the aggregate). */
async function runEvents(runId: string): Promise<RunEvent[]> {
  return asTenant(async (client) => {
    const { rows } = await client.query<RunEvent>(
      `SELECT event->>'name' AS name, destination, event->'payload' AS payload
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'runId' = $2`,
      [tenant.id, runId],
    );
    return rows;
  });
}

describe("Operations checklist templates (legend-btha)", () => {
  it("[legend-btha][OPS-01] creates a template, bumps the version on an item edit, and refuses a stale expectedUpdatedAt with 412", async () => {
    const created = await postTemplate(staff, {
      name: "Checklist tutup legend-btha",
      type: "closing",
    });
    expect(created.version).toBe(1);
    // The server mints one id per item; the client sends none.
    expect(created.items).toHaveLength(3);
    expect(
      new Set(created.items.map((item: { id: string }) => item.id)).size,
    ).toBe(3);

    const updated = await staff.client
      .patch(`/api/operations/checklist-templates/${created.id}`)
      .set(originHeader)
      .send({
        items: [
          {
            id: created.items[0].id,
            label: "Suhu chiller (revisi)",
            requiredEvidence: ["number"],
          },
        ],
        expectedUpdatedAt: created.updatedAt,
        idempotencyKey: key(),
      });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    updateChecklistTemplate.response.parse(updated.body);
    expect(updated.body.data.version).toBe(2);
    // An item the client named keeps its id.
    expect(updated.body.data.items[0].id).toBe(created.items[0].id);
    expect(updated.body.data.updatedAt).not.toBe(created.updatedAt);

    // A name-only edit leaves the version alone.
    const renamed = await staff.client
      .patch(`/api/operations/checklist-templates/${created.id}`)
      .set(originHeader)
      .send({
        name: "Checklist tutup (nama baru)",
        expectedUpdatedAt: updated.body.data.updatedAt,
        idempotencyKey: key(),
      });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.version).toBe(2);
    expect(renamed.body.data.name).toBe("Checklist tutup (nama baru)");

    // CORE PRECONDITION_FAILED: the first read is stale now.
    const stale = await staff.client
      .patch(`/api/operations/checklist-templates/${created.id}`)
      .set(originHeader)
      .send({
        name: "Basi",
        expectedUpdatedAt: created.updatedAt,
        idempotencyKey: key(),
      });
    expect(stale.status, JSON.stringify(stale.body)).toBe(412);
    expect(stale.body.error.code).toBe("PRECONDITION_FAILED");
  });

  it("[legend-btha][D-CORE-5] replays a create with the same key and refuses a reused key with a different payload", async () => {
    const payload = {
      ...templateInput({ name: "Checklist replay legend-btha" }),
      idempotencyKey: key(),
    };
    const first = await staff.client
      .post("/api/operations/checklist-templates")
      .set(originHeader)
      .send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    createdTemplateIds.push(first.body.data.id as string);
    const again = await staff.client
      .post("/api/operations/checklist-templates")
      .set(originHeader)
      .send(payload);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    const reused = await staff.client
      .post("/api/operations/checklist-templates")
      .set(originHeader)
      .send({ ...payload, name: "Payload lain" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[legend-btha][OPS-01] lists templates of one outlet, newest first, in the contract page shape", async () => {
    const response = await staff.client.get(
      `/api/operations/checklist-templates?outletId=${outletA.id}&limit=50`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    listChecklistTemplates.response.parse(response.body);
    expect(response.body.data.map((row: { id: string }) => row.id)).toContain(
      baseTemplateId,
    );
    expect(
      (
        await staff.client.get(
          `/api/operations/checklist-templates?outletId=${outletA.id}&type=nope`,
        )
      ).status,
    ).toBe(422);
  });
});

describe("Operations checklist runs (legend-btha)", () => {
  it("[legend-btha][OPS-01] derives dueAt in the outlet time zone and snapshots the template into the run", async () => {
    const template = await postTemplate(staff, {
      name: "Checklist snapshot legend-btha",
    });
    const run = await postRun(staff, template.id);
    expect(run.templateVersion).toBe(1);
    expect(run.items.map((item: { label: string }) => item.label)).toEqual([
      "Suhu chiller",
      "Foto area bar",
      "Tanda tangan supervisor",
    ]);
    expect(run.status).toBe("pending");
    expect(run.results).toEqual([]);
    expect(run.completedAt).toBeNull();
    expect(run.missedAt).toBeNull();
    expect(run.alertedAt).toBeNull();
    // The seeded outlet runs on Asia/Jakarta: 08:00 there is 01:00Z.
    const zone = await asTenant(async (client) => {
      const { rows } = await client.query<{ timezone: string }>(
        "SELECT timezone FROM outlets WHERE tenant_id = $1 AND id = $2",
        [tenant.id, outletA.id],
      );
      return rows[0]?.timezone;
    });
    expect(zone).toBe("Asia/Jakarta");
    expect(run.dueAt).toBe("2030-01-15T01:00:00.000Z");

    // A later template edit never rewrites a run's snapshot.
    const edited = await staff.client
      .patch(`/api/operations/checklist-templates/${template.id}`)
      .set(originHeader)
      .send({
        items: [{ label: "Hanya satu butir", requiredEvidence: [] }],
        expectedUpdatedAt: template.updatedAt,
        idempotencyKey: key(),
      });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.version).toBe(2);
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    getChecklistRun.response.parse(reread.body);
    expect(reread.body.data.templateVersion).toBe(1);
    expect(reread.body.data.items).toHaveLength(3);
  });

  it("[legend-btha][OPS-01] refuses an answer before the run starts and a finished answer without its required evidence", async () => {
    const run = await postRun(staff, baseTemplateId);
    const numberItem = itemIdOf(run, "Suhu chiller");
    // 409 CHECKLIST_TRANSITION_INVALID: the run is still pending.
    const early = await postResult(staff, run.id, numberItem, {
      numberValue: "4.5000",
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("CHECKLIST_TRANSITION_INVALID");

    await startRun(staff, run.id);
    // The photo item is answered "done" without a photo -> 422 OPS-01.
    const photoItem = itemIdOf(run, "Foto area bar");
    const missing = await postResult(staff, run.id, photoItem);
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(missing.body.error.code).toBe("CHECKLIST_ITEM_INCOMPLETE");
    // The run was not changed by the refused answer.
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.body.data.results).toEqual([]);
  });

  it("[legend-ga0n][OPS-01][D-CORE-5] replaying an offline answer preserves its result and rejects changed content", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const itemId = itemIdOf(run, "Suhu chiller");
    const path = `/api/operations/checklist-runs/${run.id}/items/${itemId}/result`;
    const body = {
      status: "done",
      numberValue: "4.5000",
      note: "Suhu dibaca sebelum koneksi terputus.",
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key(),
    };
    const first = await staff.client.post(path).set(originHeader).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    getChecklistRun.response.parse(first.body);
    const replay = await staff.client.post(path).set(originHeader).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(replay.body.data.results).toHaveLength(1);

    const changed = await staff.client
      .post(path)
      .set(originHeader)
      .send({ ...body, numberValue: "9.0000" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    expect(reread.body.data.results).toEqual(first.body.data.results);
  });

  it("[legend-ga0n][TEN-03] a successful answer key cannot reveal or mutate the run from another outlet", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const itemId = itemIdOf(run, "Suhu chiller");
    const path = `/api/operations/checklist-runs/${run.id}/items/${itemId}/result`;
    const body = {
      status: "done",
      numberValue: "4.5000",
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key(),
    };
    const first = await staff.client.post(path).set(originHeader).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const outsider = await outletClient(outletB.id);
    const replay = await outsider.client
      .post(path)
      .set(originHeader)
      .send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(404);
    expect(replay.body.error.code).toBe("NOT_FOUND");
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    expect(reread.body.data.results).toEqual(first.body.data.results);
  });

  it("[legend-ga0n][D-CORE-5] actor-bound retries still acknowledge answers accepted with the legacy fingerprint", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const itemId = itemIdOf(run, "Suhu chiller");
    const path = `/api/operations/checklist-runs/${run.id}/items/${itemId}/result`;
    const body = {
      status: "done",
      numberValue: "4.5000",
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key(),
    };
    const first = await staff.client.post(path).set(originHeader).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Seed the exact pre-binding canonical shape. An undefined actor key is
    // deliberately absent: stableStringify distinguishes it from omission.
    const legacyFingerprint = operationsFingerprint({
      runId: run.id,
      itemId,
      ...body,
      idempotencyKey: undefined,
    });
    const seeded = await asTenant((client) =>
      client.query(
        "UPDATE operations_idempotency SET fingerprint = $1 WHERE tenant_id = $2 AND key = $3",
        [legacyFingerprint, tenant.id, body.idempotencyKey],
      ),
    );
    expect(seeded.rowCount).toBe(1);
    const replay = await staff.client
      .post(path)
      .set(originHeader)
      .send({ ...body, expectedActorUserId: staff.userId });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    const persisted = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(persisted.status, JSON.stringify(persisted.body)).toBe(200);
    expect(persisted.body.data.results).toEqual(first.body.data.results);
  });

  it("[legend-ga0n][OPS-01] a stale queued answer cannot replace a newer confirmed answer while accepted-key replay stays safe", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const itemId = itemIdOf(run, "Suhu chiller");
    const path = `/api/operations/checklist-runs/${run.id}/items/${itemId}/result`;
    const answer = {
      status: "done",
      numberValue: "4.5000",
      note: "Pembacaan awal sebelum perangkat kehilangan koneksi.",
      photoMediaIds: [],
      signatureMediaId: null,
    };
    const acceptedKey = key();
    const original = await staff.client
      .post(path)
      .set(originHeader)
      .send({
        ...answer,
        idempotencyKey: acceptedKey,
        expectedActorUserId: staff.userId,
      });
    expect(original.status, JSON.stringify(original.body)).toBe(200);

    // Preserve the existing direct-correction contract. Another authorized
    // person records a newer measurement while the original device is away.
    const correctingActor = await ownerClient();
    const newer = await correctingActor.client
      .post(path)
      .set(originHeader)
      .send({
        ...answer,
        numberValue: "7.2500",
        note: "Pembacaan terbaru sudah dikonfirmasi.",
        idempotencyKey: key(),
      });
    expect(newer.status, JSON.stringify(newer.body)).toBe(200);
    expect(newer.body.data.results[0].numberValue).toBe("7.2500");
    expect(newer.body.data.results[0].completedBy).toBe(correctingActor.userId);

    const staleKey = key();
    const stale = await staff.client
      .post(path)
      .set(originHeader)
      .send({
        ...answer,
        idempotencyKey: staleKey,
        expectedActorUserId: staff.userId,
      });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("CHECKLIST_ANSWER_CONFLICT");
    const afterConflict = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(afterConflict.status, JSON.stringify(afterConflict.body)).toBe(200);
    expect(afterConflict.body.data.results).toEqual(newer.body.data.results);

    const replay = await staff.client
      .post(path)
      .set(originHeader)
      .send({
        ...answer,
        idempotencyKey: acceptedKey,
        expectedActorUserId: staff.userId,
      });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.results).toEqual(newer.body.data.results);
    const read = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.results).toEqual(newer.body.data.results);
  });

  it("[legend-ga0n][TEN-03] a fresh queued answer cannot be recorded under another authorized session actor", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const changedSession = await ownerClient();
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletA.id)] },
    );
    const input = {
      status: "done" as const,
      numberValue: decimal4Schema.parse("4.5000"),
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key(),
      expectedActorUserId: userIdSchema.parse(staff.userId),
    };
    await expect(
      recordChecklistItemResultService(
        context,
        changedSession.userId,
        run.id,
        itemIdOf(run, "Suhu chiller"),
        input,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "CHECKLIST_REPLAY_ACTOR_MISMATCH",
    });
    const read = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.results).toEqual([]);
  });

  it("[legend-ga0n][D-CORE-5] queued actor binding is checked before returning a successful-key replay", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const changedSession = await ownerClient();
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletA.id)] },
    );
    const input = {
      status: "done" as const,
      numberValue: decimal4Schema.parse("4.5000"),
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key(),
      expectedActorUserId: userIdSchema.parse(staff.userId),
    };
    const itemId = itemIdOf(run, "Suhu chiller");
    const first = await recordChecklistItemResultService(
      context,
      staff.userId,
      run.id,
      itemId,
      input,
    );
    await expect(
      recordChecklistItemResultService(
        context,
        changedSession.userId,
        run.id,
        itemId,
        input,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "CHECKLIST_REPLAY_ACTOR_MISMATCH",
    });
    const read = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.results).toEqual(first.results);
  });

  it("[legend-btha][OPS-01] completes a run once every item carries its evidence", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const number = await postResult(
      staff,
      run.id,
      itemIdOf(run, "Suhu chiller"),
      {
        numberValue: "4.5000",
      },
    );
    expect(number.status, JSON.stringify(number.body)).toBe(200);
    const photo = await postResult(
      staff,
      run.id,
      itemIdOf(run, "Foto area bar"),
      {
        photoMediaIds: [await storedMedia()],
      },
    );
    expect(photo.status, JSON.stringify(photo.body)).toBe(200);
    const signature = await postResult(
      staff,
      run.id,
      itemIdOf(run, "Tanda tangan supervisor"),
      { signatureMediaId: await storedMedia() },
    );
    expect(signature.status, JSON.stringify(signature.body)).toBe(200);

    const completed = await postTransition(staff, run.id, "complete");
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    getChecklistRun.response.parse(completed.body);
    expect(completed.body.data.status).toBe("completed");
    expect(completed.body.data.completedAt).not.toBeNull();
    expect(completed.body.data.results).toHaveLength(3);

    // A finished run cannot be finished again (contract machine, 409).
    const again = await postTransition(staff, run.id, "complete");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CHECKLIST_TRANSITION_INVALID");
  });

  it("[legend-btha][OPS-01] a failed item fails the run and emits checklist.failed to the outbox", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    await postResult(staff, run.id, itemIdOf(run, "Suhu chiller"), {
      numberValue: "11.0000",
      status: "failed",
      note: "Chiller terlalu hangat",
    });
    await postResult(staff, run.id, itemIdOf(run, "Foto area bar"), {
      photoMediaIds: [await storedMedia()],
    });
    await postResult(staff, run.id, itemIdOf(run, "Tanda tangan supervisor"), {
      signatureMediaId: await storedMedia(),
    });

    const failed = await postTransition(staff, run.id, "fail");
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.data.status).toBe("failed");
    expect(failed.body.data.completedAt).not.toBeNull();

    const events = await runEvents(run.id);
    const alert = events.find((event) => event.name === "checklist.failed");
    // OPS-01: a failure alerts the supervisor through the notification consumer.
    expect(alert?.destination).toBe("notification");
    expect(alert?.payload.runId).toBe(run.id);
    expect(alert?.payload.failedItemIds).toEqual([
      itemIdOf(run, "Suhu chiller"),
    ]);
  });

  it("[legend-btha][OPS-01] a miss stamps missed_at/alerted_at and queues a notification, not a silent status write", async () => {
    const run = await postRun(staff, baseTemplateId);
    const missed = await postTransition(staff, run.id, "miss");
    expect(missed.status, JSON.stringify(missed.body)).toBe(200);
    getChecklistRun.response.parse(missed.body);
    expect(missed.body.data.status).toBe("missed");
    expect(missed.body.data.missedAt).not.toBeNull();
    expect(missed.body.data.alertedAt).not.toBeNull();

    const events = await runEvents(run.id);
    const alert = events.find((event) => event.name === "checklist.missed");
    expect(alert?.destination).toBe("notification");
  });

  it("legend-18qw [OPS-01] numbers the notification stream on its own, so the supervisor alert is claimable (sequence 1)", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const missed = await postTransition(staff, run.id, "miss");
    expect(missed.status, JSON.stringify(missed.body)).toBe(200);
    const rows = await asTenant(async (client) => {
      const result = await client.query<{
        destination: string;
        sequence: string;
      }>(
        `SELECT destination, sequence FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'aggregateId' = $2
          ORDER BY destination, sequence`,
        [tenant.id, run.id],
      );
      return result.rows;
    });
    const byDestination = new Map<string, number[]>();
    for (const row of rows)
      byDestination.set(row.destination, [
        ...(byDestination.get(row.destination) ?? []),
        Number(row.sequence),
      ]);
    // Each destination's stream is gap-free from 1; a shared count used to
    // give the alert sequence > 1 and block it forever in the relay.
    expect(byDestination.get("notification")).toEqual([1]);
    for (const sequences of byDestination.values())
      expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it("[legend-btha][D-CORE-5] replays a miss with the same key instead of answering 409, and alerts once", async () => {
    const run = await postRun(staff, baseTemplateId);
    const body = { action: "miss", idempotencyKey: key() };
    const path = `/api/operations/checklist-runs/${run.id}/transition`;
    const first = await staff.client.post(path).set(originHeader).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await staff.client.post(path).set(originHeader).send(body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.status).toBe("missed");
    expect(again.body.data.missedAt).toBe(first.body.data.missedAt);
    const alerts = (await runEvents(run.id)).filter(
      (event) => event.name === "checklist.missed",
    );
    expect(alerts).toHaveLength(1);
  });

  it("[legend-btha][OPS-01][TEN-03] refuses evidence ids that are not stored objects of this tenant and the run's outlet", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const photoItem = itemIdOf(run, "Foto area bar");
    // An arbitrary UUID: no stored object at all (also what another tenant's
    // object id looks like, since the lookup is tenant-filtered and RLS'd).
    const unknown = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [randomUUID()],
    });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    expect(unknown.body.error.code).toBe("VALIDATION_ERROR");
    // A real object, but stored under outlet B: not evidence for an outlet A run.
    const foreignOutlet = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [await storedMedia(outletB.id)],
    });
    expect(foreignOutlet.status, JSON.stringify(foreignOutlet.body)).toBe(422);
    const signatureItem = itemIdOf(run, "Tanda tangan supervisor");
    const badSignature = await postResult(staff, run.id, signatureItem, {
      signatureMediaId: randomUUID(),
    });
    expect(badSignature.status, JSON.stringify(badSignature.body)).toBe(422);
    // Nothing was written by the refused answers.
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.body.data.results).toEqual([]);
    // The same item accepts a stored outlet A object.
    const ok = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [await storedMedia()],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("[legend-mg2bz][OPS-01] refuses a colleague's photo, a photo of the wrong kind, and a photo attached to another run, all with the same 422", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const other = await postRun(staff, baseTemplateId);
    const photoItem = itemIdOf(run, "Foto area bar");
    const signatureItem = itemIdOf(run, "Tanda tangan supervisor");
    const colleague = await outletClient(outletA.id);

    // Same outlet, but uploaded by a different user.
    const colleaguePhoto = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [
        await storedMedia(outletA.id, { uploadedBy: colleague.userId }),
      ],
    });
    expect(colleaguePhoto.status, JSON.stringify(colleaguePhoto.body)).toBe(
      422,
    );
    expect(colleaguePhoto.body.error.code).toBe("VALIDATION_ERROR");
    // A colleague's signature is refused the same way.
    const colleagueSignature = await postResult(staff, run.id, signatureItem, {
      signatureMediaId: await storedMedia(outletA.id, {
        uploadedBy: colleague.userId,
      }),
    });
    expect(colleagueSignature.status).toBe(422);

    // Own upload, but of another kind (a maintenance photo), or never typed.
    const wrongKind = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [
        await storedMedia(outletA.id, { sourceKind: "maintenance_ticket" }),
      ],
    });
    expect(wrongKind.status, JSON.stringify(wrongKind.body)).toBe(422);
    expect(wrongKind.body.error.code).toBe("VALIDATION_ERROR");
    const untyped = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [await storedMedia(outletA.id, { sourceKind: null })],
    });
    expect(untyped.status).toBe(422);

    // Own checklist photo, but already attached to a different run.
    const taken = await storedMedia(outletA.id, { sourceId: other.id });
    const attached = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [taken],
    });
    expect(attached.status, JSON.stringify(attached.body)).toBe(422);
    expect(attached.body.error.code).toBe("VALIDATION_ERROR");
    expect((await mediaSource(taken)).source_id).toBe(other.id);

    // Nothing was written by the refused answers.
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.body.data.results).toEqual([]);
  });

  it("[legend-mg2bz][OPS-01] accepts own checklist photo and signature, marks them as attached to the run, and lets a corrected answer keep the same photo", async () => {
    const run = await postRun(staff, baseTemplateId);
    await startRun(staff, run.id);
    const photo = await storedMedia();
    const signature = await storedMedia();
    const photoItem = itemIdOf(run, "Foto area bar");

    const first = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [photo],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const signed = await postResult(
      staff,
      run.id,
      itemIdOf(run, "Tanda tangan supervisor"),
      { signatureMediaId: signature },
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    for (const mediaId of [photo, signature])
      expect(await mediaSource(mediaId)).toEqual({
        source_kind: "checklist_evidence",
        source_id: run.id,
      });

    // The answer is corrected with the very same photo: still accepted.
    const corrected = await postResult(staff, run.id, photoItem, {
      photoMediaIds: [photo],
      note: "Dikoreksi",
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect((await mediaSource(photo)).source_id).toBe(run.id);
  });
});

describe("Operations food-safety and prep (legend-btha)", () => {
  it("[legend-btha][OPS-02] refuses an out-of-range temperature without a corrective action", async () => {
    const path = "/api/operations/temperature-logs";
    const refused = await staff.client.post(path).set(originHeader).send({
      outletId: outletA.id,
      equipmentId,
      readingCelsius: "12.5",
      correctiveAction: null,
      idempotencyKey: key(),
    });
    // OPS-02: the reading itself is valid, only the missing action is refused;
    // the contract error carries its documented 422.
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe(
      "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED",
    );

    const saved = await staff.client.post(path).set(originHeader).send({
      outletId: outletA.id,
      equipmentId,
      readingCelsius: "12.5",
      correctiveAction: "Pindahkan stok ke chiller cadangan",
      idempotencyKey: key(),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    createTemperatureLog.response.parse(saved.body);
    expect(saved.body.data.inRange).toBe(false);
    expect(saved.body.data.correctiveAction).toBe(
      "Pindahkan stok ke chiller cadangan",
    );
    expect(saved.body.data.recordedBy).toBe(staff.userId);
  });

  it("[legend-btha][OPS-03] creates a prep label for a batch and lists it by outlet", async () => {
    const configured = await staff.client
      .put(`/api/operations/prep-item-settings/${inventoryItemId}`)
      .set(originHeader)
      .send({
        outletId: outletA.id,
        shelfLifeMinutes: 90,
        idempotencyKey: key(),
      });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const producedAt = new Date(Date.now() - 60_000).toISOString();
    const created = await staff.client
      .post("/api/operations/prep-labels")
      .set(originHeader)
      .send({
        outletId: outletA.id,
        inventoryItemId,
        batchId,
        producedAt,
        idempotencyKey: key(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createPrepLabel.response.parse(created.body);
    createdPrepLabelIds.push(created.body.data.id as string);
    expect(created.body.data.producedBy).toBe(staff.userId);
    expect(created.body.data.printedAt).toBeNull();
    expect(created.body.data.useBy).toBe(
      new Date(Date.parse(producedAt) + 90 * 60_000).toISOString(),
    );

    const listed = await staff.client.get(
      `/api/operations/prep-labels?outletId=${outletA.id}&limit=50`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    listPrepLabels.response.parse(listed.body);
    expect(
      listed.body.data.some(
        (label: { id: string }) => label.id === created.body.data.id,
      ),
    ).toBe(true);
  });
});

describe("Operations outlet isolation (legend-btha)", () => {
  it("[legend-btha][TEN-03] an outlet B caller cannot read or write outlet A checklists", async () => {
    const outsider = await outletClient(outletB.id);
    // Listing another outlet is out of the server-minted scope.
    const listed = await outsider.client.get(
      `/api/operations/checklist-templates?outletId=${outletA.id}`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(403);
    // A foreign template id is a plain 404, never another outlet's row.
    const read = await outsider.client.get(
      `/api/operations/checklist-templates/${baseTemplateId}`,
    );
    expect(read.status).toBe(404);
    // Writing into outlet A is denied on the concrete outlet.
    const write = await outsider.client
      .post("/api/operations/checklist-templates")
      .set(originHeader)
      .send({
        ...templateInput({ name: "Lintas outlet" }),
        idempotencyKey: key(),
      });
    expect(write.status, JSON.stringify(write.body)).toBe(403);
    // The same caller really can read its own outlet.
    const own = await outsider.client.get(
      `/api/operations/checklist-templates?outletId=${outletB.id}`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toEqual([]);
  });

  it("[legend-btha][RBAC] a signed-in user without ops permissions is refused on every checklist route", async () => {
    const nobody = await signedIn("Operations No Role");
    const reads = [
      `/api/operations/checklist-templates?outletId=${outletA.id}`,
      `/api/operations/checklist-templates/${baseTemplateId}`,
      `/api/operations/checklist-runs?outletId=${outletA.id}`,
    ];
    for (const path of reads)
      expect((await nobody.client.get(path)).status, path).toBe(403);
    const writes = [
      "/api/operations/checklist-templates",
      "/api/operations/checklist-runs",
      `/api/operations/checklist-runs/${randomUUID()}/transition`,
    ];
    for (const path of writes)
      expect(
        (
          await nobody.client
            .post(path)
            .set(originHeader)
            .send({ action: "start", idempotencyKey: key() })
        ).status,
        path,
      ).toBe(403);
    const patched = await nobody.client
      .patch(`/api/operations/checklist-templates/${baseTemplateId}`)
      .set(originHeader)
      .send({
        name: "Tanpa izin",
        expectedUpdatedAt: new Date().toISOString(),
        idempotencyKey: key(),
      });
    expect(patched.status).toBe(403);
  });

  it("[legend-btha][TEN-01] an anonymous request is refused before any service runs", async () => {
    const anonymous = agent(app);
    expect(
      (
        await anonymous.get(
          `/api/operations/checklist-runs?outletId=${outletA.id}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await anonymous
          .post("/api/operations/checklist-runs")
          .set(originHeader)
          .send({
            outletId: outletA.id,
            templateId: baseTemplateId,
            shiftDate: "2030-01-15",
            assignedTo: randomUUID(),
            idempotencyKey: key(),
          })
      ).status,
    ).toBe(401);
  });
});
