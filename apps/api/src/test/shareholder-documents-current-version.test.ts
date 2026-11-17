// legend-d3quc (shareholder-document half; tier K, access): a shareholder dropped in the
// latest approved share version must not see documents of that entity published AFTER the
// removal ("incl. new ones" in the card), neither in the list nor by signed URL, and a
// newcomer of the latest version sees the new document. Complements
// shareholder-membership-latest-version.test.ts (legend-lt0v4), which publishes the document
// BEFORE the change. Also: a user without the shareholder role gets nothing, and a holder of
// another entity never sees this entity's documents (isolation).
//
// Assumptions: same as shareholder-membership-latest-version.test.ts (a removed holder has
// no share_allocations row in the latest approved version). A signed-in user with no
// shareholder row gets 200 with an empty list and 404 on signed-url (see
// shareholder-documents-wire.test.ts "a shareholder with no shareholder row sees nothing").
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
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
const app = createApp({ storageRuntime: runtime });

const BASE = "/api/accounting/shareholder-documents";
const PREFIX = "SHDOC-NEWDOC";
type Person = { client: ReturnType<typeof agent>; userId: string };
type Status = "pending_approval" | "approved" | "rejected";

async function signedIn(name: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function manager(): Promise<Person> {
  const person = await signedIn("Latest Manager");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Latest manager ${roleId.slice(0, 8)}`,
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

/** A signed-in user with the shareholder role and an active shareholder row. */
async function shareholder(): Promise<Person & { rowId: string }> {
  const person = await signedIn("Latest Shareholder");
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'shareholder'`,
    [tenantId, person.userId],
  );
  expect(assigned.rowCount).toBe(1);
  const rowId = randomUUID();
  await owner.query(
    `INSERT INTO shareholders (tenant_id, id, user_id, name, type, status, created_by)
     VALUES ($1, $2, $3, $4, 'person', 'active', 'latest')`,
    [tenantId, rowId, person.userId, `${PREFIX} holder`],
  );
  return { ...person, rowId };
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
    [
      tenantId,
      id,
      `${PREFIX} entity ${id.slice(0, 6)}`,
      legalEntityId,
      "latest",
    ],
  );
  return id;
}

/** Share version `version` of the entity, split evenly among `holders`, ending in `status`. */
async function shareVersion(
  entityId: string,
  version: number,
  holders: string[],
  status: Status,
  effectiveFrom?: string,
) {
  const base = Math.floor(10000 / holders.length);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO share_allocation_versions
         (tenant_id, profit_entity_id, version, effective_from, requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'latest-requester', $5)`,
      [
        tenantId,
        entityId,
        version,
        effectiveFrom ?? (version === 1 ? "2026-01-01" : "2026-02-01"),
        `latest-${randomUUID()}`,
      ],
    );
    for (const [position, shareholderId] of holders.entries())
      await client.query(
        `INSERT INTO share_allocations
           (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          entityId,
          version,
          shareholderId,
          position === 0 ? 10000 - base * (holders.length - 1) : base,
          position,
        ],
      );
    const move = (to: string, decided: boolean) =>
      client.query(
        `UPDATE share_allocation_versions
            SET status = $4,
                decided_by = CASE WHEN $5 THEN 'latest-approver' END,
                decided_at = CASE WHEN $5 THEN now() END,
                decision_note = CASE WHEN $4 = 'rejected' THEN 'Ditolak (uji versi terbaru)' END
          WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
        [tenantId, entityId, version, to, decided],
      );
    await move("pending_approval", false);
    if (status !== "pending_approval") await move(status, true);
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

async function publishedDoc(who: Person, entityId: string): Promise<string> {
  const file = await who.client
    .post(`${BASE}/files`)
    .set(originHeader)
    .field("profitEntityId", entityId)
    .attach("file", await pdf(), {
      filename: "laporan.pdf",
      contentType: "application/pdf",
    });
  expect(file.status).toBe(201);
  const created = await who.client.post(BASE).set(originHeader).send({
    profitEntityId: entityId,
    kind: "monthly_report",
    title: "Laporan versi terkini",
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

const signedUrlStatus = async (who: Person, docId: string) =>
  (
    await who.client
      .post(`${BASE}/${docId}/signed-url`)
      .set(originHeader)
      .send({})
  ).status;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

describe("legend-d3quc shareholder documents follow the current approved version only", () => {
  it("a holder removed by the latest approved version does not see a document published after the removal; the newcomer does", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const removed = await shareholder();
    const stays = await shareholder();
    const newcomer = await shareholder();
    await shareVersion(entityId, 1, [removed.rowId, stays.rowId], "approved");
    await shareVersion(entityId, 2, [stays.rowId, newcomer.rowId], "approved");

    const doc = await publishedDoc(mgr, entityId);

    expect(await listIds(removed)).not.toContain(doc);
    expect(await signedUrlStatus(removed, doc)).toBe(404);
    expect(await listIds(stays)).toContain(doc);
    expect(await signedUrlStatus(stays, doc)).toBe(200);
    expect(await listIds(newcomer)).toContain(doc);
    expect(await signedUrlStatus(newcomer, doc)).toBe(200);
  });

  it("a holder of another entity sees nothing of this entity, new documents included", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const otherEntityId = await entity();
    const inside = await shareholder();
    const outsider = await shareholder();
    await shareVersion(entityId, 1, [inside.rowId], "approved");
    await shareVersion(otherEntityId, 1, [outsider.rowId], "approved");

    const doc = await publishedDoc(mgr, entityId);

    expect(await listIds(inside)).toContain(doc);
    expect(await listIds(outsider)).not.toContain(doc);
    expect(await signedUrlStatus(outsider, doc)).toBe(404);
  });

  it("a signed-in user without any shareholder role sees nothing", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const holder = await shareholder();
    await shareVersion(entityId, 1, [holder.rowId], "approved");
    const doc = await publishedDoc(mgr, entityId);
    const plain = await signedIn("No Shareholder Role");

    // Assumption: a user without the shareholder role is refused (403); a 200 with an
    // empty list would also be acceptable, so only "no document leaks" is asserted.
    const listed = await plain.client.get(BASE);
    expect([200, 403]).toContain(listed.status);
    expect(JSON.stringify(listed.body)).not.toContain(doc);
    expect([403, 404]).toContain(await signedUrlStatus(plain, doc));
  });
});
