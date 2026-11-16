// Edge print queue API (bead legend-46p; PRD v1.7 §3 F5 "Print Agent",
// EDG-05; contract listPrintJobs / reprintPrintJob / retryPrintJob /
// listEdgePrinters in @starter/shared/edge). Real Express app in edge mode,
// Better Auth, RBAC and PostgreSQL with RLS (disposable server from
// `pnpm test`), in a fresh isolated tenant. The edge identity is installed
// through the runtime test seam.
//
// Covers: 503 off the edge, 401 anonymous, 403 without permission (order.view
// alone included) or without a trusted Origin, list / reprint / retry happy
// paths, the reprint label on the ESC/POS bytes, the reprint and retry audit
// rows, concurrent same-key reprint, 409 on invalid transitions (a failed job
// is retried, not reprinted) and 404 for another tenant's or outlet's job.
// Also: only cashiers (pos.sale.create) reprint or retry, shift reports need a
// shift permission, list content is hidden from readers who may not hand it
// out, and retry of a half-printed (write / stale) job makes a marked reprint.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  listEdgePrinters,
  listPrintJobs,
  printJobSchema,
  reprintPrintJob,
} from "@starter/shared/edge";
import { createApp } from "../app.ts";
import { setEdgeRuntimeStateForTests } from "../edge/runtime.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seedTenantOutlets,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ESC_AT = Buffer.from([0x1b, 0x40]);
const offEdge = {
  edgeMode: false,
  identity: null,
  link: {
    cloudLink: "disconnected",
    refused: false,
    lastConnectedAt: null,
  },
} as const;

const ids = {
  operatorRole: randomUUID(),
  readerRole: randomUUID(),
  kdsRole: randomUUID(),
  shiftRole: randomUUID(),
  noneRole: randomUUID(),
  edgeNode: randomUUID(),
  printer: randomUUID(),
  otherOutletPrinter: randomUUID(),
  otherTenantPrinter: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let otherOutletId: string;
let otherTenantId: string;
let otherTenantOutletId: string;
type Member = { client: ReturnType<typeof agent>; userId: string };
let operator: Member;
let reader: Member;
let kds: Member;
let shiftCashier: Member;
let nobody: Member;

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

async function member(roleId: string, label: string): Promise<Member> {
  // Sign-up is cloud only (edgeRouteGuard); the edge app only signs in.
  const email = await signUp(agent(createApp()), label);
  const client = agent(app);
  const signIn = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: "Test-password-123!" });
  expect(signIn.status).toBe(200);
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

async function insertPrinter(
  tenantId: string,
  outletId: string,
  printerId: string,
  label: string,
) {
  await asOwnerTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width)
       VALUES ($1, $2, $3, $4, 'receipt', 'network', '192.168.1.50', 9100, 48)`,
      [printerId, tenantId, outletId, label],
    ),
  );
}

/** A job straight from the fixture side, in any status. */
async function insertJob(input: {
  tenantId: string;
  outletId: string;
  printerId: string;
  status: "queued" | "printed" | "failed";
  text?: string;
  kind?: "receipt" | "shift_report";
  failurePhase?: "write" | "stale" | "other";
}): Promise<string> {
  const id = createUlid();
  const content = Buffer.concat([
    ESC_AT,
    Buffer.from(input.text ?? "Struk uji\n", "ascii"),
  ]);
  await asOwnerTenant(input.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_print_jobs
         (id, tenant_id, outlet_id, printer_id, kind, status, content, attempts, idempotency_key, source_ref, failure_phase, printed_at)
       VALUES ($1, $2, $3, $4, $8, $5, $6, 1, $7, 'RCP-001', $9,
               CASE WHEN $5::varchar = 'printed' THEN now() END)`,
      [
        ulidToUuid(id),
        input.tenantId,
        input.outletId,
        input.printerId,
        input.status,
        content,
        `seed-${id}`,
        input.kind ?? "receipt",
        input.status === "failed" ? (input.failurePhase ?? "other") : null,
      ],
    ),
  );
  return id;
}

function api(who: Member) {
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`/api/edge${path}`)
      .set(headers)
      .set(originHeader)
      .send(body);
  const sendWithoutOrigin = (path: string, body: Record<string, unknown>) =>
    who.client.post(`/api/edge${path}`).set(headers).send(body);
  return {
    list: (query = "") =>
      who.client.get(`/api/edge/print-jobs${query}`).set(headers),
    printers: () => who.client.get("/api/edge/printers").set(headers),
    reprint: (jobId: string, idempotencyKey = randomUUID()) =>
      send(`/print-jobs/${jobId}/reprint`, { idempotencyKey }),
    retry: (jobId: string) =>
      send(`/print-jobs/${jobId}/retry`, { idempotencyKey: randomUUID() }),
    retryWithKey: (jobId: string, idempotencyKey: string) =>
      send(`/print-jobs/${jobId}/retry`, { idempotencyKey }),
    reprintWithoutOrigin: (jobId: string) =>
      sendWithoutOrigin(`/print-jobs/${jobId}/reprint`, {
        idempotencyKey: randomUUID(),
      }),
    retryWithoutOrigin: (jobId: string) =>
      sendWithoutOrigin(`/print-jobs/${jobId}/retry`, {
        idempotencyKey: randomUUID(),
      }),
  };
}

beforeAll(async () => {
  app = createApp({ edgeMode: true });
  tenant = await createIsolatedTenant(`prn-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  [otherOutletId] = await seedTenantOutlets(tenant.tenantId, 1);
  otherTenantId = randomUUID();
  [otherTenantOutletId] = await seedTenantOutlets(otherTenantId, 1);
  const roles: [string, string, string[]][] = [
    [ids.operatorRole, "Cetak Operator Uji", ["order.view", "pos.sale.create"]],
    [ids.readerRole, "Cetak Order View Uji", ["order.view"]],
    [ids.noneRole, "Tanpa Cetak", ["floor.table.view"]],
    [ids.kdsRole, "Cetak KDS Uji", ["kds.ticket.process"]],
    [
      ids.shiftRole,
      "Cetak Kasir Shift Uji",
      ["pos.sale.create", "shift.cash.view_all"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  operator = await member(ids.operatorRole, "Cetak Operator");
  reader = await member(ids.readerRole, "Cetak Pembaca");
  nobody = await member(ids.noneRole, "Cetak Tamu");
  kds = await member(ids.kdsRole, "Cetak KDS");
  shiftCashier = await member(ids.shiftRole, "Cetak Kasir Shift");
  await insertPrinter(tenant.tenantId, tenant.outletId, ids.printer, "Kasir");
  await insertPrinter(
    tenant.tenantId,
    otherOutletId,
    ids.otherOutletPrinter,
    "Outlet Lain",
  );
  await insertPrinter(
    otherTenantId,
    otherTenantOutletId,
    ids.otherTenantPrinter,
    "Tenant Lain",
  );
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(offEdge);
  // Audit rows are append-only, so the isolated tenant stays in the disposable
  // database; give it a valid creator so the platform tenant list parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

function asEdgeNode() {
  const context = edgeNodeContext({
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context,
      scope: {
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        edgeNodeId: ids.edgeNode,
      },
    },
    link: offEdge.link,
  });
}

describe("edge print queue API (legend-46p)", () => {
  it("EDG-05 answers 503 EDGE_NOT_READY when the process is not an edge node", async () => {
    setEdgeRuntimeStateForTests(offEdge);
    const res = await api(operator).list();
    expect(res.status).toBe(503);
    expect(res.body.error?.code ?? res.body.code).toBe("EDGE_NOT_READY");
    expect((await api(operator).printers()).status).toBe(503);
  });

  it("answers 401 to an anonymous caller and 403 without a print permission", async () => {
    asEdgeNode();
    const anonymous = await agent(app).get("/api/edge/print-jobs").set(headers);
    expect(anonymous.status).toBe(401);
    const denied = await api(nobody).list();
    expect(denied.status).toBe(403);
    expect((await api(nobody).printers()).status).toBe(403);
    // order.view alone no longer opens the queue: job content can hold names.
    expect((await api(reader).list()).status).toBe(403);
    expect((await api(reader).printers()).status).toBe(403);
    const original = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    expect((await api(reader).reprint(original)).status).toBe(403);
    expect((await api(nobody).retry(original)).status).toBe(403);
  });

  it("lists the outlet's printers and jobs only, newest first, without caching", async () => {
    asEdgeNode();
    const first = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const second = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
    });
    const foreignOutlet = await insertJob({
      tenantId: tenant.tenantId,
      outletId: otherOutletId,
      printerId: ids.otherOutletPrinter,
      status: "printed",
    });
    const foreignTenant = await insertJob({
      tenantId: otherTenantId,
      outletId: otherTenantOutletId,
      printerId: ids.otherTenantPrinter,
      status: "printed",
    });

    const list = await api(operator).list("?limit=50");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    const page = listPrintJobs.response.parse(list.body);
    const listed = page.data.map((job) => job.id);
    expect(listed).toContain(first);
    expect(listed).toContain(second);
    expect(listed.indexOf(second)).toBeLessThan(listed.indexOf(first));
    expect(listed).not.toContain(foreignOutlet);
    expect(listed).not.toContain(foreignTenant);
    for (const job of page.data) {
      expect(job.tenantId).toBe(tenant.tenantId);
      expect(job.outletId).toBe(tenant.outletId);
    }

    const failedOnly = await api(operator).list("?status=failed&limit=50");
    expect(failedOnly.status).toBe(200);
    for (const job of failedOnly.body.data) expect(job.status).toBe("failed");

    const paged = await api(operator).list("?limit=1");
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta.nextCursor).toBeTruthy();
    const next = await api(operator).list(
      `?limit=1&cursor=${encodeURIComponent(paged.body.meta.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data[0]?.id).not.toBe(paged.body.data[0]?.id);

    const printers = await api(operator).printers();
    expect(printers.status).toBe(200);
    const parsed = listEdgePrinters.response.parse(printers.body);
    expect(parsed.data.map((printer) => printer.id)).toEqual([ids.printer]);
  });

  it("reprints a printed job as a new job with the reprint label, audited and idempotent", async () => {
    asEdgeNode();
    const original = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
      text: "Total Rp 55.000\n",
    });
    const key = randomUUID();
    const res = await api(operator).reprint(original, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const { data } = reprintPrintJob.response.parse(res.body);
    expect(data.id).not.toBe(original);
    expect(data.reprintOf).toBe(original);
    expect(data.status).toBe("queued");
    expect(data.printerId).toBe(ids.printer);
    expect(data.kind).toBe("receipt");
    printJobSchema.parse(data);

    const bytes = Buffer.from(data.content ?? "", "base64");
    expect(bytes.subarray(0, 2).equals(ESC_AT)).toBe(true);
    expect(bytes.toString("latin1")).toContain("CETAK ULANG");
    expect(bytes.toString("latin1")).toContain("Total Rp 55.000");

    // The same key returns the same reprint, never a second job.
    const again = await api(operator).reprint(original, key);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(data.id);
    const { rows: jobs } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM edge_print_jobs WHERE reprint_of = $1",
        [ulidToUuid(original)],
      ),
    );
    expect(jobs[0].n).toBe(1);

    // The audit row landed on the tenant and names the actor.
    const { rows: audit } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `SELECT event FROM audit_logs
         WHERE tenant_id = $1 AND event->>'action' = 'print_job.reprinted'
           AND event->>'objectId' = $2`,
        [tenant.tenantId, data.id],
      ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].event.actorId).toBe(operator.userId);
    expect(audit[0].event.maskedChanges.after).toMatchObject({
      originalJobId: original,
      kind: "receipt",
      printerId: ids.printer,
      sourceRef: "[REDACTED]",
    });
  });

  it("reprints concurrently with one key: same job, one row, one audit row", async () => {
    asEdgeNode();
    const original = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const key = randomUUID();
    const results = await Promise.all([
      api(operator).reprint(original, key),
      api(operator).reprint(original, key),
      api(operator).reprint(original, key),
    ]);
    for (const res of results)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const jobIds = new Set(results.map((res) => res.body.data.id));
    expect(jobIds.size).toBe(1);
    const [jobId] = [...jobIds] as string[];
    const { rows: jobs } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM edge_print_jobs WHERE reprint_of = $1",
        [ulidToUuid(original)],
      ),
    );
    expect(jobs[0].n).toBe(1);
    const { rows: audit } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `SELECT 1 FROM audit_logs
         WHERE tenant_id = $1 AND event->>'action' = 'print_job.reprinted'
           AND event->>'objectId' = $2`,
        [tenant.tenantId, jobId],
      ),
    );
    expect(audit).toHaveLength(1);
  });

  it("answers 409 when an idempotency key is reused for another original", async () => {
    asEdgeNode();
    const first = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const second = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const key = randomUUID();
    expect((await api(operator).reprint(first, key)).status).toBe(201);
    expect((await api(operator).reprint(second, key)).status).toBe(409);
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM edge_print_jobs WHERE reprint_of = $1",
        [ulidToUuid(second)],
      ),
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses to reprint a failed job (retry is the way) and answers 409", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
    });
    expect((await api(operator).reprint(failed)).status).toBe(409);
  });

  it("refuses a mutation without a trusted Origin with 403", async () => {
    asEdgeNode();
    const printed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
    });
    expect((await api(operator).reprintWithoutOrigin(printed)).status).toBe(
      403,
    );
    expect((await api(operator).retryWithoutOrigin(failed)).status).toBe(403);
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM edge_print_jobs WHERE id = $1",
        [ulidToUuid(failed)],
      ),
    );
    expect(rows[0].status).toBe("failed");
  });

  it("refuses to reprint a job that has not finished and answers 409", async () => {
    asEdgeNode();
    const queued = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "queued",
    });
    const res = await api(operator).reprint(queued);
    expect(res.status).toBe(409);
  });

  it("retries a failed job once; any other status is 409", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
    });
    const res = await api(operator).retry(failed);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(printJobSchema.parse(res.body.data)).toMatchObject({
      id: failed,
      status: "queued",
    });
    // The requeue and its audit row share one transaction.
    const { rows: audit } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `SELECT event FROM audit_logs
         WHERE tenant_id = $1 AND event->>'action' = 'print_job.retried'
           AND event->>'objectId' = $2`,
        [tenant.tenantId, failed],
      ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].event.actorId).toBe(operator.userId);
    expect(audit[0].event.maskedChanges).toMatchObject({
      before: { status: "failed" },
      after: {
        status: "queued",
        kind: "receipt",
        printerId: ids.printer,
        sourceRef: "[REDACTED]",
      },
    });
    expect((await api(operator).retry(failed)).status).toBe(409);
    const printed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    expect((await api(operator).retry(printed)).status).toBe(409);
  });

  it("answers 403 to reprint and retry for a KDS-only user (reprint is for cashiers)", async () => {
    asEdgeNode();
    const printed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
    });
    // The KDS user can still read the queue.
    expect((await api(kds).list()).status).toBe(200);
    expect((await api(kds).reprint(printed)).status).toBe(403);
    expect((await api(kds).retry(failed)).status).toBe(403);
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM edge_print_jobs WHERE id = $1",
        [ulidToUuid(failed)],
      ),
    );
    expect(rows[0].status).toBe("failed");
  });

  it("reprints a shift report only with a shift permission", async () => {
    asEdgeNode();
    const report = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
      kind: "shift_report",
      text: "Tutup shift Rp 1.000.000\n",
    });
    const denied = await api(operator).reprint(report);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code ?? denied.body.code).toBe(
      "PERMISSION_DENIED",
    );
    const { rows: none } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query("SELECT 1 FROM edge_print_jobs WHERE reprint_of = $1", [
        ulidToUuid(report),
      ]),
    );
    expect(none).toHaveLength(0);
    const allowed = await api(shiftCashier).reprint(report);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.data.kind).toBe("shift_report");
    expect(allowed.body.data.reprintOf).toBe(report);
  });

  it("hides content in the list from readers who may not hand it out", async () => {
    asEdgeNode();
    const receipt = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
    });
    const report = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "printed",
      kind: "shift_report",
    });
    const contentOf = async (who: Member, id: string) => {
      const res = await api(who).list("?limit=100");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const job = listPrintJobs.response
        .parse(res.body)
        .data.find((item) => item.id === id);
      expect(job, `job ${id} listed`).toBeDefined();
      return job?.content;
    };
    // KDS-only: no bytes at all.
    expect(await contentOf(kds, receipt)).toBeNull();
    expect(await contentOf(kds, report)).toBeNull();
    // Cashier without shift permissions: receipt yes, shift report no.
    expect(await contentOf(operator, receipt)).toEqual(expect.any(String));
    expect(await contentOf(operator, report)).toBeNull();
    // Cashier with a shift permission sees both.
    expect(await contentOf(shiftCashier, report)).toEqual(expect.any(String));
  });

  it("retry of a write- or stale-failed job makes a marked reprint and leaves the original failed", async () => {
    asEdgeNode();
    for (const failurePhase of ["write", "stale"] as const) {
      const failed = await insertJob({
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        printerId: ids.printer,
        status: "failed",
        failurePhase,
        text: "Total Rp 77.000\n",
      });
      const key = randomUUID();
      const res = await api(operator).retryWithKey(failed, key);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const job = printJobSchema.parse(res.body.data);
      expect(job.id).not.toBe(failed);
      expect(job.reprintOf).toBe(failed);
      expect(job.status).toBe("queued");
      const bytes = Buffer.from(job.content ?? "", "base64").toString("latin1");
      expect(bytes).toContain("CETAK ULANG");
      expect(bytes).toContain("Total Rp 77.000");

      // The original stays failed with its phase; the same key returns the same reprint.
      const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query<{ status: string; failure_phase: string }>(
          "SELECT status, failure_phase FROM edge_print_jobs WHERE id = $1",
          [ulidToUuid(failed)],
        ),
      );
      expect(rows[0]).toEqual({
        status: "failed",
        failure_phase: failurePhase,
      });
      const again = await api(operator).retryWithKey(failed, key);
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(job.id);
      // Audited as a reprint with the retry reason.
      const { rows: audit } = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `SELECT event FROM audit_logs
           WHERE tenant_id = $1 AND event->>'action' = 'print_job.reprinted'
             AND event->>'objectId' = $2`,
          [tenant.tenantId, job.id],
        ),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].event.reason).toBe("retry");
    }
  });

  it("retry of a write-failed shift report needs a shift permission", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
      failurePhase: "write",
      kind: "shift_report",
    });
    expect((await api(operator).retry(failed)).status).toBe(403);
    const res = await api(shiftCashier).retry(failed);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.reprintOf).toBe(failed);
  });

  it("retry of a write-failed job already reprinted under another key is 409; the same key replays", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
      failurePhase: "write",
    });
    const key = randomUUID();
    const first = await api(operator).retryWithKey(failed, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await api(operator).retryWithKey(failed, randomUUID());
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(JSON.stringify(second.body)).toContain(
      "Tugas ini sudah dicetak ulang.",
    );
    const replay = await api(operator).retryWithKey(failed, key);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query("SELECT 1 FROM edge_print_jobs WHERE reprint_of = $1", [
        ulidToUuid(failed),
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  it("plain requeue of an other-failed shift report needs a shift permission", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
      failurePhase: "other",
      kind: "shift_report",
    });
    expect((await api(operator).retry(failed)).status).toBe(403);
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM edge_print_jobs WHERE id = $1",
        [ulidToUuid(failed)],
      ),
    );
    expect(rows[0].status).toBe("failed");
    const res = await api(shiftCashier).retry(failed);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: failed, status: "queued" });
  });

  it("retry of an other-failed job requeues the same job and clears the phase", async () => {
    asEdgeNode();
    const failed = await insertJob({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      printerId: ids.printer,
      status: "failed",
      failurePhase: "other",
    });
    const res = await api(operator).retry(failed);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: failed,
      status: "queued",
      reprintOf: null,
    });
    const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query<{ status: string; failure_phase: string | null }>(
        "SELECT status, failure_phase FROM edge_print_jobs WHERE id = $1",
        [ulidToUuid(failed)],
      ),
    );
    expect(rows[0]).toEqual({ status: "queued", failure_phase: null });
  });

  it("TEN-01 TEN-03 another tenant's or outlet's job id is 404, and an unknown id too", async () => {
    asEdgeNode();
    const foreignOutlet = await insertJob({
      tenantId: tenant.tenantId,
      outletId: otherOutletId,
      printerId: ids.otherOutletPrinter,
      status: "failed",
    });
    const foreignTenant = await insertJob({
      tenantId: otherTenantId,
      outletId: otherTenantOutletId,
      printerId: ids.otherTenantPrinter,
      status: "failed",
    });
    for (const id of [foreignOutlet, foreignTenant, createUlid()]) {
      expect((await api(operator).reprint(id)).status).toBe(404);
      expect((await api(operator).retry(id)).status).toBe(404);
    }
    // The foreign failed jobs are untouched.
    const { rows } = await owner
      .query<{ status: string }>(
        `SELECT status FROM edge_print_jobs WHERE id = ANY($1::uuid[])`,
        [[ulidToUuid(foreignOutlet), ulidToUuid(foreignTenant)]],
      )
      .catch(() => ({ rows: [] as { status: string }[] }));
    for (const row of rows) expect(row.status).toBe("failed");
  });
});
