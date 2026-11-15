// Shareholder documents (PRD §3.35 Dokumen, §6 I `shareholder_documents`, SH-01;
// bead legend-69yq). HTTP tests run the real Better Auth, tenant resolver, RBAC
// resolver, PostgreSQL and RLS. The real app factory cannot inject storage or
// the membership resolver, so the router is mounted on a test express app with
// the same auth + tenant middleware as app.ts, an in-memory object store and a
// mutable membership map.
//
// Assumptions: a non-PDF upload answers 415 and an empty one 422; a user
// with no relevant permission gets 403 on every route; the manager role is a
// custom tenant-scope role holding only `profit_share.registry.manage`; the shareholder is the seeded `shareholder`
// template (holds `profit_share.own.view`). Published documents cannot be
// deleted (DB trigger), so tests use fresh random profit entities and filter
// by them instead of cleaning up.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  listShareholderDocuments,
  shareholderDocumentSchema,
} from "@starter/shared/accounting";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createShareholderDocumentsRouter } from "../routes/shareholder-documents.routes";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image";
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { agent, originHeader, signUp } from "./helpers";
import { validPdfBytes } from "./helpers/pdf-fixtures";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const TEN_MIB = 10 * 1024 * 1024;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

/** userId -> profit entity ids the injected membership port resolves. */
const memberships = new Map<string, string[]>();
const membership = {
  async profitEntityIdsForUser(
    _tx: unknown,
    _context: unknown,
    userId: string,
  ) {
    return memberships.get(userId) ?? [];
  },
};
/** Counts writes so a rejected upload can be proven to have stored nothing. */
class CountingStorage extends FakeObjectStorage {
  puts = 0;
  deletes = 0;
  /** Runs once right after the blob is stored, to force a race with the DB insert. */
  afterPut: (() => Promise<void>) | null = null;
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    this.puts += 1;
    const result = await super.put(...args);
    const hook = this.afterPut;
    this.afterPut = null;
    if (hook) await hook();
    return result;
  }
  override async delete(
    ...args: Parameters<FakeObjectStorage["delete"]>
  ): ReturnType<FakeObjectStorage["delete"]> {
    this.deletes += 1;
    return super.delete(...args);
  }
  /** Number of blobs currently held (the fake keeps them in a private map). */
  get objectCount(): number {
    return (this as unknown as { objects: Map<string, unknown> }).objects.size;
  }
}
const storage = new CountingStorage();
const scanner = new NoopMalwareScanner();
/** Rejects any object containing the marker, like a scanner flagging malware. */
const INFECTED = "X5O!P%@AP-EICAR-TEST";
const infectionScanner: MalwareScanner = {
  async scan(bytes) {
    if (Buffer.from(bytes).includes(INFECTED))
      throw new Error("malware detected");
  },
};

function buildApp(
  tenantId: string,
  router: express.Router,
): ReturnType<typeof express> {
  const app = express();
  app.use(requestContext);
  app.all("/api/auth/*splat", limitAuthBody, toNodeHandler(auth));
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain: async (hostname) => {
        const resolution = await resolveHostname(hostname);
        return resolution.ok
          ? { tenantId: resolution.tenantId, brandId: resolution.brandId }
          : null;
      },
      verifyCredential: deviceTenantCredential,
      // Test stand-in for the development tenant fallback: the signed-in
      // caller's tenant is the one this app instance was built for.
      fallback: async (req) => {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
          query: { disableCookieCache: true },
        });
        return session ? { tenantId, brandId: null, source: "session" } : null;
      },
    }),
  );
  app.use("/api/accounting", router);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const appA = buildApp(
  tenantA,
  createShareholderDocumentsRouter({ storage, scanner, membership }),
);
const appB = buildApp(
  tenantB,
  createShareholderDocumentsRouter({ storage, scanner, membership }),
);
// No storage wired: upload answers 503 (after the permission check).
const appNoStorage = buildApp(
  tenantA,
  createShareholderDocumentsRouter({ storage: null, scanner, membership }),
);
// No membership option: production default, fail closed.
const appFailClosed = buildApp(
  tenantA,
  createShareholderDocumentsRouter({ storage, scanner }),
);
// Scanner variants: one that flags infected bytes, one not wired at all.
const appInfection = buildApp(
  tenantA,
  createShareholderDocumentsRouter({
    storage,
    scanner: infectionScanner,
    membership,
  }),
);
// Production scanner (noop, acceptsDocuments false): PDFs are refused (legend-0w2wy).
const appNoDocScanner = buildApp(
  tenantA,
  createShareholderDocumentsRouter({
    storage,
    scanner: new NoopMalwareScanner({ acceptsDocuments: false }),
    membership,
  }),
);
const appNoScanner = buildApp(
  tenantA,
  createShareholderDocumentsRouter({ storage, membership }),
);

const BASE = "/api/accounting/shareholder-documents";
const LIST = listShareholderDocuments.path;

type Client = ReturnType<typeof agent>;
type Person = { client: Client; userId: string };

async function signedIn(app: express.Express, name: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  return { client, userId };
}

async function customRole(
  tenantId: string,
  userId: string,
  permissions: string[],
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Shareholder docs test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

async function manager(app = appA, tenantId: string = tenantA) {
  const person = await signedIn(app, "Docs Manager");
  await customRole(tenantId, person.userId, ["profit_share.registry.manage"]);
  return person;
}

async function shareholder(entityIds: string[]) {
  const person = await signedIn(appA, "Docs Shareholder");
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'shareholder'`,
    [tenantA, person.userId],
  );
  expect(assigned.rowCount).toBe(1);
  memberships.set(person.userId, entityIds);
  return person;
}

/** A signed-in user with no role at all. */
const nobody = () => signedIn(appA, "Docs Nobody");

const pdf = async (extra = "") =>
  Buffer.from(await validPdfBytes({ marker: extra || undefined }));

/** A structurally valid PDF whose bytes contain the scanner marker in clear
 * (content streams are compressed, so the marker rides in the catalog). */
async function infectedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.catalog.set(PDFName.of("Note"), PDFString.of(INFECTED));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function upload(
  who: Person,
  entityId: string,
  bytes: Buffer,
  filename = "laporan.pdf",
) {
  return who.client
    .post(`${BASE}/files`)
    .set(originHeader)
    .field("profitEntityId", entityId)
    .attach("file", bytes, { filename, contentType: "application/pdf" });
}

async function uploadOk(who: Person, entityId: string) {
  // Unique bytes so each upload is a distinct object.
  const response = await upload(
    who,
    entityId,
    await pdf(randomBytes(8).toString("hex")),
  );
  expect(response.status).toBe(201);
  return response.body.data as {
    fileKey: string;
    contentType: string;
    sizeBytes: number;
  };
}

function createDoc(who: Person, body: Record<string, unknown>) {
  return who.client.post(BASE).set(originHeader).send(body);
}

type DocOptions = {
  kind?: string;
  title?: string;
  visibility?: "shareholders" | "management";
  publish?: boolean;
};

/** Upload + create (+ publish) as `who`; answers the document row. */
async function newDoc(who: Person, entityId: string, options: DocOptions = {}) {
  const file = await uploadOk(who, entityId);
  const created = await createDoc(who, {
    profitEntityId: entityId,
    kind: options.kind ?? "monthly_report",
    title: options.title ?? "Laporan Bulanan",
    fileKey: file.fileKey,
    visibility: options.visibility ?? "shareholders",
  });
  expect(created.status).toBe(201);
  let doc = shareholderDocumentSchema.parse(created.body.data);
  if (options.publish) {
    const published = await publish(who, doc.id);
    expect(published.status).toBe(200);
    doc = shareholderDocumentSchema.parse(published.body.data);
  }
  return doc;
}

const publish = (who: Person, id: string) =>
  who.client
    .post(`${BASE}/${id}/publish`)
    .set(originHeader)
    .send({ idempotencyKey: `publish-${randomUUID()}` });

const signedUrl = (who: Person, id: string) =>
  who.client.post(`${BASE}/${id}/signed-url`).set(originHeader).send({});

const listIds = async (who: Person, query = "") => {
  const response = await who.client.get(`${LIST}${query}`);
  expect(response.status).toBe(200);
  return (response.body.data as { id: string }[]).map((row) => row.id);
};

/** Marks the entities this file creates so afterAll can remove them again. */
const ENTITY_PREFIX = "SHDOC-TEST";

/** A real profit entity (and its legal entity) owned by `tenantId`. */
async function entity(tenantId: string = tenantA): Promise<string> {
  const legalEntityId = randomUUID();
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [
      legalEntityId,
      tenantId,
      `${ENTITY_PREFIX} PT ${legalEntityId.slice(0, 8)}`,
    ],
  );
  await owner.query(
    `INSERT INTO profit_entities
       (tenant_id, id, name, type, legal_entity_id, reserve_bp, frequency, tax_withholding_bp, created_by)
     VALUES ($1, $2, $3, 'legal_entity', $4, 0, 'quarterly', 0, $5)`,
    [
      tenantId,
      id,
      `${ENTITY_PREFIX} entity ${id.slice(0, 6)}`,
      legalEntityId,
      randomUUID(),
    ],
  );
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Shareholder docs tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `sh-docs-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
});

afterAll(async () => {
  // Tenant B only owns uploaded file rows and roles (never documents), so it
  // can be removed. Published tenant A documents are immutable and stay
  // (harmless: every test uses fresh random profit entities). Each delete runs on its own so one failure is reported, not
  // hidden behind the rest.
  const failures: unknown[] = [];
  for (const [sql, params] of [
    // Tenant A is shared: remove this file's entities where nothing published
    // still points at them (a published document can never be deleted).
    [
      `DELETE FROM shareholder_documents d USING profit_entities e
        WHERE d.tenant_id = e.tenant_id AND d.profit_entity_id = e.id
          AND e.name LIKE $1 AND d.published_at IS NULL`,
      [`${ENTITY_PREFIX} entity %`],
    ],
    [
      `DELETE FROM shareholder_document_files f USING profit_entities e
        WHERE f.tenant_id = e.tenant_id AND f.profit_entity_id = e.id
          AND e.name LIKE $1
          AND NOT EXISTS (SELECT 1 FROM shareholder_documents d
            WHERE d.tenant_id = f.tenant_id AND d.file_key = f.file_key)`,
      [`${ENTITY_PREFIX} entity %`],
    ],
    [
      `DELETE FROM profit_entities e
        WHERE e.name LIKE $1
          AND NOT EXISTS (SELECT 1 FROM shareholder_document_files f
            WHERE f.tenant_id = e.tenant_id AND f.profit_entity_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM shareholder_documents d
            WHERE d.tenant_id = e.tenant_id AND d.profit_entity_id = e.id)`,
      [`${ENTITY_PREFIX} entity %`],
    ],
    [
      `DELETE FROM legal_entities l
        WHERE l.name LIKE $1
          AND NOT EXISTS (SELECT 1 FROM profit_entities e
            WHERE e.tenant_id = l.tenant_id AND e.legal_entity_id = l.id)`,
      [`${ENTITY_PREFIX} PT %`],
    ],
    ["DELETE FROM shareholder_document_files WHERE tenant_id = $1", [tenantB]],
    ["DELETE FROM profit_entities WHERE tenant_id = $1", [tenantB]],
    ["DELETE FROM legal_entities WHERE tenant_id = $1", [tenantB]],
    ["DELETE FROM role_assignments WHERE tenant_id = $1", [tenantB]],
    ["DELETE FROM roles WHERE tenant_id = $1", [tenantB]],
    ["DELETE FROM tenants WHERE id = $1", [tenantB]],
  ] as const) {
    try {
      await owner.query(sql, [...params]);
    } catch (error) {
      failures.push(error);
    }
  }
  await Promise.all([owner.end(), appPool.end()]);
  if (failures.length > 0) throw failures[0];
});

describe("legend-69yq shareholder documents", () => {
  it("1. manager uploads a PDF, creates a draft, publishes once and republish is idempotent", async () => {
    const mgr = await manager();
    const entityId = await entity();

    const bytes = await pdf();
    const uploaded = await upload(mgr, entityId, bytes);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.fileKey).toMatch(
      /^shareholder-documents\/[0-9a-f-]{36}\.pdf$/,
    );
    // Never the user's file name.
    expect(uploaded.body.data.fileKey).not.toContain("laporan");
    expect(uploaded.body.data.contentType).toBe("application/pdf");
    expect(uploaded.body.data.sizeBytes).toBe(bytes.length);

    const created = await createDoc(mgr, {
      profitEntityId: entityId,
      kind: "general_meeting_minutes",
      title: "Notulen RUPS",
      fileKey: uploaded.body.data.fileKey,
      visibility: "shareholders",
    });
    expect(created.status).toBe(201);
    const draft = shareholderDocumentSchema.parse(created.body.data);
    expect(draft).toMatchObject({
      profitEntityId: entityId,
      tenantId: tenantA,
      kind: "general_meeting_minutes",
      title: "Notulen RUPS",
      visibility: "shareholders",
      publishedAt: null,
      publishedBy: null,
    });

    const first = await publish(mgr, draft.id);
    expect(first.status).toBe(200);
    const published = shareholderDocumentSchema.parse(first.body.data);
    expect(published.publishedAt).not.toBeNull();
    expect(published.publishedBy).toBe(mgr.userId);

    const second = await publish(mgr, draft.id);
    expect(second.status).toBe(200);
    expect(second.body.data.publishedAt).toBe(published.publishedAt);

    const audits = await owner.query<{ action: string }>(
      `SELECT event->>'action' AS action FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' LIKE 'shareholder_document.%'`,
      [tenantA, draft.id],
    );
    const actions = audits.rows.map((row) => row.action).sort();
    expect(actions).toEqual([
      "shareholder_document.created",
      "shareholder_document.published",
    ]);

    // The manager sees the document, filtered by entity and kind.
    expect(await listIds(mgr, `?profitEntityId=${entityId}`)).toEqual([
      draft.id,
    ]);
    expect(
      await listIds(mgr, `?profitEntityId=${entityId}&kind=other`),
    ).toEqual([]);
  });

  it("2. rejects non-PDF, empty and oversized uploads and callers without permission", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const putsBefore = storage.puts;

    // Magic bytes decide, not the declared type or file name.
    const asPng = await upload(mgr, entityId, png);
    expect(asPng.status).toBe(415);
    const asText = await upload(
      mgr,
      entityId,
      Buffer.from("just some text, not a pdf"),
      "notes.txt",
    );
    expect(asText.status).toBe(415);
    const empty = await upload(mgr, entityId, Buffer.alloc(0));
    expect(empty.status).toBe(422);

    const tooBig = await upload(
      mgr,
      entityId,
      Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(TEN_MIB)]),
    );
    expect(tooBig.status).toBe(413);

    const anon = await agent(appA)
      .post(`${BASE}/files`)
      .set(originHeader)
      .field("profitEntityId", entityId)
      .attach("file", await pdf(), {
        filename: "a.pdf",
        contentType: "application/pdf",
      });
    expect(anon.status).toBe(401);

    const stranger = await nobody();
    expect((await upload(stranger, entityId, await pdf())).status).toBe(403);

    // Nothing was stored for the rejected uploads.
    const rows = await owner.query(
      "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, entityId],
    );
    expect(rows.rowCount).toBe(0);
    // Nor was any object written to storage.
    expect(storage.puts).toBe(putsBefore);
  });

  it("2b. an infected PDF is rejected and not stored; without a scanner upload is 503", async () => {
    const entityId = await entity();
    const putsBefore = storage.puts;

    const infectedMgr = await manager(appInfection);
    const infected = await upload(infectedMgr, entityId, await infectedPdf());
    expect(infected.status).toBeGreaterThanOrEqual(400);
    expect(infected.status).not.toBe(201);
    // A clean PDF through the same scanner is accepted.
    expect((await upload(infectedMgr, entityId, await pdf())).status).toBe(201);

    const mgr = await manager(appNoScanner);
    expect((await upload(mgr, entityId, await pdf())).status).toBe(503);
    const stranger = await signedIn(appNoScanner, "Docs Nobody No Scanner");
    expect((await upload(stranger, entityId, await pdf())).status).toBe(403);

    // Only the one clean upload was written and recorded.
    expect(storage.puts).toBe(putsBefore + 1);
    const rows = await owner.query(
      "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, entityId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("2c. a scanner that does not accept documents answers 503 and stores nothing (legend-0w2wy)", async () => {
    const entityId = await entity();
    const putsBefore = storage.puts;
    const mgr = await manager(appNoDocScanner);
    const res = await upload(mgr, entityId, await pdf());
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error.message).toContain("pemindai malware");
    expect(storage.puts).toBe(putsBefore);
    const rows = await owner.query(
      "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, entityId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("3. create rejects a file not uploaded, from another profit entity or already used (422)", async () => {
    const mgr = await manager();
    const entityA = await entity();
    const entityB = await entity();
    const body = (fileKey: string, profitEntityId = entityA) => ({
      profitEntityId,
      kind: "other",
      title: "Dokumen",
      fileKey,
      visibility: "shareholders",
    });

    const unknown = await createDoc(
      mgr,
      body(`shareholder-documents/${randomUUID()}.pdf`),
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.error?.code).toBe("VALIDATION_ERROR");

    const file = await uploadOk(mgr, entityA);
    // File belongs to entity A; creating under entity B must fail.
    const wrongEntity = await createDoc(mgr, body(file.fileKey, entityB));
    expect(wrongEntity.status).toBe(422);

    const ok = await createDoc(mgr, body(file.fileKey));
    expect(ok.status).toBe(201);
    // One file, one document.
    const reused = await createDoc(mgr, body(file.fileKey));
    expect(reused.status).toBe(422);

    // A file uploaded by another tenant's manager is unknown here.
    const mgrB = await manager(appB, tenantB);
    const foreign = await uploadOk(mgrB, await entity(tenantB));
    const crossTenant = await createDoc(mgr, body(foreign.fileKey, entityB));
    expect(crossTenant.status).toBe(422);

    // Strict body: unknown fields and a bad kind are rejected.
    expect(
      (await createDoc(mgr, { ...body(file.fileKey), tenantId: tenantA }))
        .status,
    ).toBe(422);
    expect(
      (await createDoc(mgr, { ...body(file.fileKey), kind: "invoice" })).status,
    ).toBe(422);
  });

  it("4. shareholder lists only published, shareholder-visible documents of own entity", async () => {
    const mgr = await manager();
    const entityA = await entity();
    const entityB = await entity();
    const visible = await newDoc(mgr, entityA, { publish: true });
    const second = await newDoc(mgr, entityA, {
      publish: true,
      kind: "other",
    });
    const draft = await newDoc(mgr, entityA);
    const management = await newDoc(mgr, entityA, {
      publish: true,
      visibility: "management",
    });
    const otherEntity = await newDoc(mgr, entityB, { publish: true });

    const holder = await shareholder([entityA]);
    const ids = await listIds(holder);
    expect(ids).toContain(visible.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(management.id);
    expect(ids).not.toContain(otherEntity.id);
    // Asking for the other entity explicitly still shows nothing of it.
    expect(await listIds(holder, `?profitEntityId=${entityB}`)).toEqual([]);

    // Contract shape on every row.
    const page = await holder.client.get(`${LIST}?limit=1`);
    expect(page.status).toBe(200);
    for (const row of page.body.data) shareholderDocumentSchema.parse(row);
    expect(page.headers["cache-control"]).toMatch(/no-store/);

    // Cursor pagination walks the visible set without gaps or repeats.
    const seen: string[] = [];
    const pageUrl = (after: string | null) =>
      `${LIST}?limit=1${after ? `&cursor=${encodeURIComponent(after)}` : ""}`;
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const next = await holder.client.get(pageUrl(cursor));
      expect(next.status).toBe(200);
      const body = next.body as {
        data: { id: string }[];
        meta: { nextCursor: string | null };
      };
      seen.push(...body.data.map((row) => row.id));
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([visible.id, second.id]));

    // The manager still sees everything, drafts and management-only included.
    const managerIds = await listIds(mgr, `?profitEntityId=${entityA}`);
    expect(managerIds).toEqual(
      expect.arrayContaining([visible.id, draft.id, management.id]),
    );

    // A user with no permission cannot list at all.
    expect((await (await nobody()).client.get(LIST)).status).toBe(403);
    expect((await agent(appA).get(LIST)).status).toBe(401);
  });

  it("5. signed URL: shareholder gets own published doc; draft, management and other entity are 404", async () => {
    const mgr = await manager();
    const entityA = await entity();
    const entityB = await entity();
    const own = await newDoc(mgr, entityA, { publish: true });
    const draft = await newDoc(mgr, entityA);
    const management = await newDoc(mgr, entityA, {
      publish: true,
      visibility: "management",
    });
    const foreign = await newDoc(mgr, entityB, { publish: true });
    const holder = await shareholder([entityA]);

    const ok = await signedUrl(holder, own.id);
    expect(ok.status).toBe(200);
    expect(() => new URL(ok.body.data.url)).not.toThrow();
    const expiresIn = Date.parse(ok.body.data.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(300_000 + 5_000);
    expect(ok.headers["cache-control"]).toMatch(/no-store/);
    // The URL points at this document's file, and differs per document.
    expect(ok.body.data.url).toContain(encodeURIComponent(own.fileKey));
    const other = await signedUrl(mgr, draft.id);
    expect(other.status).toBe(200);
    expect(other.body.data.url).toContain(encodeURIComponent(draft.fileKey));
    expect(other.body.data.url).not.toBe(ok.body.data.url);

    for (const doc of [draft, management, foreign]) {
      const denied = await signedUrl(holder, doc.id);
      expect(denied.status).toBe(404);
      expect(denied.body.error?.code).toBe("NOT_FOUND");
    }
    // An unknown id is indistinguishable from a hidden one.
    expect((await signedUrl(holder, randomUUID())).status).toBe(404);

    // The manager may fetch any document of the tenant, drafts included.
    expect((await signedUrl(mgr, draft.id)).status).toBe(200);
    expect((await signedUrl(mgr, management.id)).status).toBe(200);

    // No permission at all: 403.
    expect((await signedUrl(await nobody(), own.id)).status).toBe(403);
    expect(
      (await signedUrl({ client: agent(appA), userId: "" }, own.id)).status,
    ).toBe(401);

    // A shareholder cannot upload, create or publish.
    expect((await upload(holder, entityA, await pdf())).status).toBe(403);
    expect(
      (
        await createDoc(holder, {
          profitEntityId: entityA,
          kind: "other",
          title: "Tidak boleh",
          fileKey: `shareholder-documents/${randomUUID()}.pdf`,
          visibility: "shareholders",
        })
      ).status,
    ).toBe(403);
    expect((await publish(holder, draft.id)).status).toBe(403);
    // And the draft stayed a draft.
    const row = await owner.query(
      "SELECT published_at FROM shareholder_documents WHERE tenant_id = $1 AND id = $2",
      [tenantA, draft.id],
    );
    expect(row.rows[0].published_at).toBeNull();
  });

  it("6. tenant B cannot see or publish tenant A documents; RLS is forced and restrictive", async () => {
    const mgrA = await manager();
    const entityId = await entity();
    const draft = await newDoc(mgrA, entityId);
    const published = await newDoc(mgrA, entityId, { publish: true });

    const mgrB = await manager(appB, tenantB);
    expect(await listIds(mgrB)).not.toContain(draft.id);
    expect(await listIds(mgrB)).not.toContain(published.id);
    expect(await listIds(mgrB, `?profitEntityId=${entityId}`)).toEqual([]);
    expect((await publish(mgrB, draft.id)).status).toBe(404);
    expect((await signedUrl(mgrB, published.id)).status).toBe(404);
    const untouched = await owner.query(
      "SELECT published_at FROM shareholder_documents WHERE tenant_id = $1 AND id = $2",
      [tenantA, draft.id],
    );
    expect(untouched.rows[0].published_at).toBeNull();

    const names = ["shareholder_document_files", "shareholder_documents"];
    const catalog = await appPool.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled,
              c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS restrictive
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [names],
    );
    expect(catalog.rows).toEqual(
      names.map((name) => ({
        name,
        enabled: true,
        forced: true,
        restrictive: true,
      })),
    );

    // Tenant A really has rows (owner bypasses RLS), tenant B's app role sees none of them.
    const total = await owner.query(
      "SELECT count(*)::int AS n FROM shareholder_documents WHERE tenant_id = $1",
      [tenantA],
    );
    expect(total.rows[0].n).toBeGreaterThan(0);
    for (const table of names) {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantB],
        );
        // Tenant B legitimately owns a file row (test 3); it must see no other.
        const rows = await client.query(
          `SELECT 1 FROM ${table} WHERE tenant_id <> $1`,
          [tenantB],
        );
        expect(rows.rowCount).toBe(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  });

  it("7. a published row is immutable at database level", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const doc = await newDoc(mgr, entityId, { publish: true });
    const update = (set: string, ...params: unknown[]) =>
      owner.query(
        `UPDATE shareholder_documents SET ${set} WHERE tenant_id = $1 AND id = $2`,
        [tenantA, doc.id, ...params],
      );

    // 42501 = insufficient_privilege, raised by the immutability trigger.
    await expect(update("visibility = 'management'")).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/immutable/),
    });
    await expect(update("title = $3", "Diganti")).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/immutable/),
    });
    await expect(
      update("published_at = NULL, published_by = NULL"),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/immutable/),
    });
    await expect(
      owner.query(
        "DELETE FROM shareholder_documents WHERE tenant_id = $1 AND id = $2",
        [tenantA, doc.id],
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/immutable/),
    });

    const row = await owner.query(
      "SELECT visibility, title, published_at FROM shareholder_documents WHERE tenant_id = $1 AND id = $2",
      [tenantA, doc.id],
    );
    expect(row.rows[0]).toMatchObject({
      visibility: "shareholders",
      title: "Laporan Bulanan",
    });
    expect(row.rows[0].published_at).not.toBeNull();
  });

  it("8. default membership is fail-closed: a shareholder sees nothing", async () => {
    const mgr = await manager();
    const entityId = await entity();
    const doc = await newDoc(mgr, entityId, { publish: true });

    const failClosed = agent(appFailClosed);
    await signUp(failClosed, "Docs Fail Closed");
    const session = await failClosed.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = 'shareholder'`,
      [tenantA, userId],
    );
    // Even with a membership entry recorded for this user, the default port ignores it.
    memberships.set(userId, [entityId]);
    const closed = await failClosed.get(LIST);
    expect(closed.status).toBe(200);
    expect(closed.body.data).toEqual([]);
    expect(
      (await signedUrl({ client: failClosed, userId }, doc.id)).status,
    ).toBe(404);
  });

  it("9. without storage, upload is 503 for a manager but permission (403) wins for a user without a role", async () => {
    const mgr = await manager(appNoStorage);
    const entityId = await entity();
    expect((await upload(mgr, entityId, await pdf())).status).toBe(503);

    const stranger = await signedIn(appNoStorage, "Docs Nobody No Storage");
    expect((await upload(stranger, entityId, await pdf())).status).toBe(403);
    const rows = await owner.query(
      "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, entityId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("10. a caller without any role gets 403 before input validation", async () => {
    const stranger = await nobody();

    // Malformed id.
    const malformed = await stranger.client
      .post(`${BASE}/not-a-uuid/signed-url`)
      .set(originHeader)
      .send({});
    expect(malformed.status).toBe(403);

    // No JSON content type.
    const plain = await stranger.client
      .post(`${BASE}/${randomUUID()}/signed-url`)
      .set(originHeader)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(plain.status).toBe(403);

    // Invalid pagination query.
    expect((await stranger.client.get(`${LIST}?limit=abc`)).status).toBe(403);

    // A permitted caller still gets the validation error for the same input.
    const mgr = await manager();
    expect((await mgr.client.get(`${LIST}?limit=abc`)).status).toBe(422);
  });

  it("11. composite FK shareholder_documents_file_fk rejects a mismatched entity or unknown file (23503)", async () => {
    const mgr = await manager();
    const entityA = await entity();
    const file = await uploadOk(mgr, entityA);
    const insert = (profitEntityId: string, fileKey: string) =>
      owner.query(
        `INSERT INTO shareholder_documents
           (tenant_id, id, profit_entity_id, kind, title, file_key, visibility, created_by)
         VALUES ($1, $2, $3, 'other', 'Uji FK', $4, 'shareholders', $5)`,
        [tenantA, randomUUID(), profitEntityId, fileKey, mgr.userId],
      );

    await expect(insert(await entity(), file.fileKey)).rejects.toMatchObject({
      code: "23503",
      constraint: "shareholder_documents_file_fk",
    });
    await expect(
      insert(entityA, `shareholder-documents/${randomUUID()}.pdf`),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "shareholder_documents_file_fk",
    });
    // The matching pair is accepted.
    await expect(insert(entityA, file.fileKey)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("12. profit entity FK: a file for an unknown or another tenant's profit entity is refused (23503)", async () => {
    const mgr = await manager();
    const fileRow = (tenantId: string, profitEntityId: string) =>
      owner.query(
        `INSERT INTO shareholder_document_files
           (tenant_id, id, profit_entity_id, file_key, content_type, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, 'application/pdf', 1, $5)`,
        [
          tenantId,
          randomUUID(),
          profitEntityId,
          `shareholder-documents/${randomUUID()}.pdf`,
          mgr.userId,
        ],
      );
    const docRow = (tenantId: string, profitEntityId: string) =>
      owner.query(
        `INSERT INTO shareholder_documents
           (tenant_id, id, profit_entity_id, kind, title, file_key, visibility, created_by)
         VALUES ($1, $2, $3, 'other', 'Uji FK', $4, 'shareholders', $5)`,
        [
          tenantId,
          randomUUID(),
          profitEntityId,
          `shareholder-documents/${randomUUID()}.pdf`,
          mgr.userId,
        ],
      );

    const entityA = await entity();
    const entityOfB = await entity(tenantB);
    await expect(fileRow(tenantA, entityA)).resolves.toMatchObject({
      rowCount: 1,
    });
    for (const profitEntityId of [randomUUID(), entityOfB]) {
      await expect(fileRow(tenantA, profitEntityId)).rejects.toMatchObject({
        code: "23503",
        constraint: "shareholder_document_files_profit_entity_fk",
      });
      await expect(docRow(tenantA, profitEntityId)).rejects.toMatchObject({
        code: "23503",
      });
    }
    // A profit entity that still has an uploaded file cannot be deleted.
    await expect(
      owner.query(
        "DELETE FROM profit_entities WHERE tenant_id = $1 AND id = $2",
        [tenantA, entityA],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("13. upload and create for an unknown or another tenant's profit entity are 422 PROFIT_ENTITY_NOT_FOUND and store nothing", async () => {
    const mgr = await manager();
    for (const profitEntityId of [randomUUID(), await entity(tenantB)]) {
      const putsBefore = storage.puts;
      const response = await upload(
        mgr,
        profitEntityId,
        await pdf("fk-refused"),
      );
      expect(response.status).toBe(422);
      expect(response.body.error?.code).toBe("PROFIT_ENTITY_NOT_FOUND");
      expect(storage.puts).toBe(putsBefore);
      const rows = await owner.query(
        "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
        [tenantA, profitEntityId],
      );
      expect(rows.rowCount).toBe(0);

      const created = await createDoc(mgr, {
        profitEntityId,
        kind: "other",
        title: "Dokumen",
        fileKey: `shareholder-documents/${randomUUID()}.pdf`,
        visibility: "shareholders",
      });
      expect(created.status).toBe(422);
      expect(created.body.error?.code).toBe("PROFIT_ENTITY_NOT_FOUND");
      const docs = await owner.query(
        "SELECT 1 FROM shareholder_documents WHERE tenant_id = $1 AND profit_entity_id = $2",
        [tenantA, profitEntityId],
      );
      expect(docs.rowCount).toBe(0);
    }
  });

  it("14. profit entity deleted between pre-check and insert: 422 PROFIT_ENTITY_NOT_FOUND and the stored blob is deleted", async () => {
    const mgr = await manager();
    const profitEntityId = await entity();
    // Pre-check passes, put stores the blob, then the entity vanishes before the insert (FK 23503).
    storage.afterPut = async () => {
      await owner.query(
        "DELETE FROM profit_entities WHERE tenant_id = $1 AND id = $2",
        [tenantA, profitEntityId],
      );
    };
    const putsBefore = storage.puts;
    const deletesBefore = storage.deletes;
    const objectsBefore = storage.objectCount;
    const response = await upload(mgr, profitEntityId, await pdf("fk-race"));
    expect(response.status).toBe(422);
    expect(response.body.error?.code).toBe("PROFIT_ENTITY_NOT_FOUND");
    expect(storage.puts).toBe(putsBefore + 1);
    expect(storage.deletes).toBe(deletesBefore + 1);
    expect(storage.objectCount).toBe(objectsBefore);
    const rows = await owner.query(
      "SELECT 1 FROM shareholder_document_files WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, profitEntityId],
    );
    expect(rows.rowCount).toBe(0);
  });
});
