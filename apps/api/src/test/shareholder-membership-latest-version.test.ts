// Shareholder document access follows the LATEST APPROVED share version
// (bead legend-lt0v4; SH-01). A profit entity's share versions are numbered
// 1, 2, ...; the allocation in force is the highest version whose status is
// approved. A shareholder who appears in an older approved version but not in
// the latest approved one has been removed and loses access to that entity's
// documents. A higher version that is not approved (pending_approval or
// rejected) changes nothing: the previous approved version still decides.
//
// Assumptions (the brief does not pin these down):
// - "Not in the latest approved version" means no share_allocations row for
//   the shareholder in that version (a removed holder is simply not listed).
// - A rejected version is reached through pending_approval with a decision
//   (decided_by/decided_at set), like an approval.
// - Version 2 carries a later effective_from than version 1.
//
// Same wiring as shareholder-documents-wire.test.ts (real DB membership
// resolver through createApp); every test owns fresh profit entities.

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
const PREFIX = "SHDOC-LATEST";
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

describe("legend-lt0v4 shareholder access follows the latest approved share version", () => {
  it("SH-01 a holder removed in the latest approved version loses the documents; the holder who stays and a newcomer see them", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const removed = await shareholder();
    const stays = await shareholder();
    const newcomer = await shareholder();
    await shareVersion(entityId, 1, [removed.rowId, stays.rowId], "approved");
    const doc = await publishedDoc(mgr, entityId);
    // Before v2 both v1 holders see the document.
    expect(await listIds(removed)).toContain(doc);
    expect(await listIds(stays)).toContain(doc);

    await shareVersion(entityId, 2, [stays.rowId, newcomer.rowId], "approved");

    // Today: the removed holder still sees it (any approved version counts).
    expect(await listIds(removed)).not.toContain(doc);
    expect(await signedUrlStatus(removed, doc)).toBe(404);
    expect(await listIds(stays)).toContain(doc);
    expect(await signedUrlStatus(stays, doc)).toBe(200);
    expect(await listIds(newcomer)).toContain(doc);
    expect(await signedUrlStatus(newcomer, doc)).toBe(200);
  });

  it("SH-01 a higher version still pending approval does not remove access (v1 stays in force)", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const holder = await shareholder();
    const other = await shareholder();
    await shareVersion(entityId, 1, [holder.rowId], "approved");
    await shareVersion(entityId, 2, [other.rowId], "pending_approval");
    const doc = await publishedDoc(mgr, entityId);

    expect(await listIds(holder)).toContain(doc);
    expect(await signedUrlStatus(holder, doc)).toBe(200);
    // The pending newcomer gains nothing before approval.
    expect(await listIds(other)).not.toContain(doc);
    expect(await signedUrlStatus(other, doc)).toBe(404);
  });

  it("SH-01 a rejected higher version does not remove access either", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const holder = await shareholder();
    const other = await shareholder();
    await shareVersion(entityId, 1, [holder.rowId], "approved");
    await shareVersion(entityId, 2, [other.rowId], "rejected");
    const doc = await publishedDoc(mgr, entityId);

    expect(await listIds(holder)).toContain(doc);
    expect(await listIds(other)).not.toContain(doc);
  });

  it("SH-01 access moves with the latest approval: a pending removal takes effect only when approved", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const holder = await shareholder();
    const other = await shareholder();
    await shareVersion(entityId, 1, [holder.rowId], "approved");
    const doc = await publishedDoc(mgr, entityId);
    await shareVersion(entityId, 2, [other.rowId], "pending_approval");
    expect(await listIds(holder)).toContain(doc);

    // Version 2 gets approved (the latest approved version is now 2).
    await owner.query(
      `UPDATE share_allocation_versions
          SET status = 'approved', decided_by = 'latest-approver', decided_at = now()
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 2`,
      [tenantId, entityId],
    );
    expect(await listIds(holder)).not.toContain(doc);
    expect(await signedUrlStatus(holder, doc)).toBe(404);
    expect(await listIds(other)).toContain(doc);
  });

  // Assumption: an approved version only governs access from its effective_from
  // date. Until then the previous approved version (v1) still decides. No clock
  // mocking: "future" is a far-future date (2099-01-01), "past" is a date that
  // has already gone by (2026-02-01, today is after it).
  it("SH-01 an approved v2 with a future effective_from leaves access with the v1 holders; the newcomer gets nothing yet", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const a = await shareholder();
    const b = await shareholder();
    const c = await shareholder();
    await shareVersion(entityId, 1, [a.rowId, b.rowId], "approved");
    const doc = await publishedDoc(mgr, entityId);
    // v2 drops B and adds C, approved but not yet in force.
    await shareVersion(
      entityId,
      2,
      [a.rowId, c.rowId],
      "approved",
      "2099-01-01",
    );

    expect(await listIds(a)).toContain(doc);
    expect(await signedUrlStatus(a, doc)).toBe(200);
    expect(await listIds(b)).toContain(doc);
    expect(await signedUrlStatus(b, doc)).toBe(200);
    expect(await listIds(c)).not.toContain(doc);
    expect(await signedUrlStatus(c, doc)).toBe(404);
  });

  it("SH-01 once the effective_from of the approved v2 has passed, access flips: B is out, C is in", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const a = await shareholder();
    const b = await shareholder();
    const c = await shareholder();
    await shareVersion(entityId, 1, [a.rowId, b.rowId], "approved");
    const doc = await publishedDoc(mgr, entityId);
    // Same change as above, but v2's date is already in the past.
    await shareVersion(
      entityId,
      2,
      [a.rowId, c.rowId],
      "approved",
      "2026-02-01",
    );

    expect(await listIds(a)).toContain(doc);
    expect(await listIds(b)).not.toContain(doc);
    expect(await signedUrlStatus(b, doc)).toBe(404);
    expect(await listIds(c)).toContain(doc);
    expect(await signedUrlStatus(c, doc)).toBe(200);
  });

  it("SH-01 a holder in two entities loses only the entity they were removed from", async () => {
    const mgr = await manager();
    const kept = await entity();
    const dropped = await entity();
    const holder = await shareholder();
    const other = await shareholder();
    await shareVersion(kept, 1, [holder.rowId], "approved");
    await shareVersion(dropped, 1, [holder.rowId], "approved");
    const keptDoc = await publishedDoc(mgr, kept);
    const droppedDoc = await publishedDoc(mgr, dropped);
    await shareVersion(dropped, 2, [other.rowId], "approved");

    const ids = await listIds(holder);
    expect(ids).toContain(keptDoc);
    expect(ids).not.toContain(droppedDoc);
  });
});
