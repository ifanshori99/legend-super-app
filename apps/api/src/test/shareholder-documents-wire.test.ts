// Shareholder documents wired in createApp (bead legend-68if): the storage
// runtime and scanner reach createShareholderDocumentsRouter (upload no longer
// answers 503), and the real DB membership resolver decides which profit
// entities a shareholder sees: only those with an APPROVED share version that
// lists the caller's active shareholder row. Without a runtime, upload is 503
// but the read side still works. profitEntityId is validated on upload/create.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import { owner, seededTenantId as tenantId } from "./floor-test-helpers.ts";

const storage = new FakeObjectStorage();
const runtime: StorageRuntime = {
  storage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => "https://signed.example.test/x",
  hrisDocumentSigner: async () => null,
};
const appWithStorage = createApp({ storageRuntime: runtime });
const appWithoutStorage = createApp({ storageRuntime: null });

const BASE = "/api/accounting/shareholder-documents";
const PREFIX = "SHDOC-WIRE";
type Person = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(
  app: ReturnType<typeof createApp>,
  name: string,
): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function manager(app: ReturnType<typeof createApp>): Promise<Person> {
  const person = await signedIn(app, "Wire Manager");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Wire manager ${roleId.slice(0, 8)}`,
      JSON.stringify(["profit_share.registry.manage"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, person.userId, roleId],
  );
  return person;
}

async function shareholderUser(
  app: ReturnType<typeof createApp>,
): Promise<Person> {
  const person = await signedIn(app, "Wire Shareholder");
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'shareholder'`,
    [tenantId, person.userId],
  );
  expect(assigned.rowCount).toBe(1);
  return person;
}

async function entity(): Promise<string> {
  const legalEntityId = randomUUID();
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenantId, `${PREFIX} PT ${legalEntityId.slice(0, 8)}`],
  );
  await owner.query(
    `INSERT INTO profit_entities
       (tenant_id, id, name, type, legal_entity_id, reserve_bp, frequency, tax_withholding_bp, created_by)
     VALUES ($1, $2, $3, 'legal_entity', $4, 0, 'quarterly', 0, $5)`,
    [tenantId, id, `${PREFIX} entity ${id.slice(0, 6)}`, legalEntityId, "wire"],
  );
  return id;
}

/** The caller's shareholder row (one per user and tenant). */
async function shareholderRow(
  userId: string,
  status: "active" | "inactive" = "active",
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO shareholders (tenant_id, id, user_id, name, type, status, created_by)
     VALUES ($1, $2, $3, $4, 'person', $5, 'wire')`,
    [tenantId, id, userId, `${PREFIX} holder`, status],
  );
  return id;
}

/** Share version 1 of `entityId` giving the shareholder 100%, in `status`. */
async function shareVersion(
  entityId: string,
  shareholderId: string,
  status: "pending_approval" | "approved",
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO share_allocation_versions
         (tenant_id, profit_entity_id, version, effective_from, requested_by, idempotency_key)
       VALUES ($1, $2, 1, '2026-01-01', 'wire-requester', $3)`,
      [tenantId, entityId, `wire-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO share_allocations
         (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
       VALUES ($1, $2, 1, $3, 10000, 0)`,
      [tenantId, entityId, shareholderId],
    );
    const move = (to: string, decided: boolean) =>
      client.query(
        `UPDATE share_allocation_versions
            SET status = $3,
                decided_by = CASE WHEN $4 THEN 'wire-approver' END,
                decided_at = CASE WHEN $4 THEN now() END
          WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
        [tenantId, entityId, to, decided],
      );
    await move("pending_approval", false);
    if (status === "approved") await move("approved", true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const pdf = async () =>
  Buffer.from(await validPdfBytes({ marker: randomBytes(8).toString("hex") }));

const upload = async (who: Person, entityId: string) =>
  who.client
    .post(`${BASE}/files`)
    .set(originHeader)
    .field("profitEntityId", entityId)
    .attach("file", await pdf(), {
      filename: "laporan.pdf",
      contentType: "application/pdf",
    });

/** Upload + create + publish as manager; answers the document id. */
async function publishedDoc(who: Person, entityId: string): Promise<string> {
  const file = await upload(who, entityId);
  expect(file.status).toBe(201);
  const created = await who.client.post(BASE).set(originHeader).send({
    profitEntityId: entityId,
    kind: "monthly_report",
    title: "Laporan Wire",
    fileKey: file.body.data.fileKey,
    visibility: "shareholders",
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  const published = await who.client
    .post(`${BASE}/${id}/publish`)
    .set(originHeader)
    .send({ idempotencyKey: `publish-${randomUUID()}` });
  expect(published.status).toBe(200);
  return id;
}

const listIds = async (who: Person) => {
  const res = await who.client.get(BASE);
  expect(res.status).toBe(200);
  return (res.body.data as { id: string }[]).map((row) => row.id);
};

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  // Published documents are immutable and stay (every test uses fresh
  // entities); remove what can go. Draft rows would block nothing here.
  await owner.query(
    `DELETE FROM share_allocations a USING profit_entities e
      WHERE a.tenant_id = e.tenant_id AND a.profit_entity_id = e.id
        AND e.name LIKE $1 AND NOT EXISTS (
          SELECT 1 FROM shareholder_documents d
           WHERE d.tenant_id = e.tenant_id AND d.profit_entity_id = e.id)`,
    [`${PREFIX} entity %`],
  );
});

describe("legend-68if shareholder documents wired in createApp", () => {
  it("with a storage runtime a manager uploads, creates and publishes (no 503)", async () => {
    const mgr = await manager(appWithStorage);
    const entityId = await entity();
    const before = (storage as unknown as { objects: Map<string, unknown> })
      .objects.size;
    await publishedDoc(mgr, entityId);
    expect(
      (storage as unknown as { objects: Map<string, unknown> }).objects.size,
    ).toBe(before + 1);
  });

  it("membership comes from an approved allocation: approved sees, pending/other/inactive see nothing", async () => {
    const mgr = await manager(appWithStorage);
    const approvedEntity = await entity();
    const pendingEntity = await entity();
    const inactiveEntity = await entity();
    const otherEntity = await entity();
    const holder = await shareholderUser(appWithStorage);
    const holderRow = await shareholderRow(holder.userId);
    await shareVersion(approvedEntity, holderRow, "approved");
    await shareVersion(pendingEntity, holderRow, "pending_approval");
    const inactive = await shareholderUser(appWithStorage);
    await shareVersion(
      inactiveEntity,
      await shareholderRow(inactive.userId, "inactive"),
      "approved",
    );

    const approvedDoc = await publishedDoc(mgr, approvedEntity);
    const pendingDoc = await publishedDoc(mgr, pendingEntity);
    const inactiveDoc = await publishedDoc(mgr, inactiveEntity);
    const otherDoc = await publishedDoc(mgr, otherEntity);

    const ids = await listIds(holder);
    expect(ids).toContain(approvedDoc);
    expect(ids).not.toContain(pendingDoc);
    expect(ids).not.toContain(inactiveDoc);
    expect(ids).not.toContain(otherDoc);
    expect(await listIds(inactive)).not.toContain(inactiveDoc);

    const ok = await holder.client
      .post(`${BASE}/${approvedDoc}/signed-url`)
      .set(originHeader)
      .send({});
    expect(ok.status).toBe(200);
    const denied = await holder.client
      .post(`${BASE}/${otherDoc}/signed-url`)
      .set(originHeader)
      .send({});
    expect(denied.status).toBe(404);
  });

  it("a shareholder with no shareholder row sees nothing", async () => {
    const stranger = await shareholderUser(appWithStorage);
    expect(await listIds(stranger)).toEqual([]);
  });

  it("an unknown profitEntityId is 422 on upload and create", async () => {
    const mgr = await manager(appWithStorage);
    const missing = randomUUID();
    const up = await upload(mgr, missing);
    expect(up.status).toBe(422);
    expect(up.body.error?.code ?? up.body.code).toBe("PROFIT_ENTITY_NOT_FOUND");
    const created = await mgr.client
      .post(BASE)
      .set(originHeader)
      .send({
        profitEntityId: missing,
        kind: "other",
        title: "Tanpa entitas",
        fileKey: `shareholder-documents/${randomUUID()}.pdf`,
        visibility: "shareholders",
      });
    expect(created.status).toBe(422);
  });

  it("without a storage runtime upload is 503 but reads still answer", async () => {
    const mgr = await manager(appWithoutStorage);
    const entityId = await entity();
    expect((await upload(mgr, entityId)).status).toBe(503);
    expect((await mgr.client.get(BASE)).status).toBe(200);
  });
});
