// Fail-first tests for report exports (WS-11 F12, bead legend-ay6e6). From the
// contract in packages/shared/src/dashboard/exports.ts (reportExportSchema,
// reportExportGate, DASH-04) and the CTO decision of 27 Nov: personal data and
// money figures only reach a caller holding that report's permission, another
// user's / tenant's / outlet's job is a 404, and a CSV is safe from formula
// injection.
//
// The generation sweep (`sweepReportExports`) is what the worker tick runs;
// the tests call it directly with the tenant's context.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  reportExportPageSchema,
  reportExportSchema,
  type ReportExport,
} from "@starter/shared/dashboard";
import { createApp } from "../app";
import { sweepReportExports } from "../services/report-exports.service";
import {
  neutralizeFormula,
  renderCsv,
  renderXlsx,
} from "../services/report-export-files";
import { agent, originHeader } from "./helpers";
import { owner } from "./floor-test-helpers";
import {
  JUNE,
  makeDeliveryWorld,
  tenantContext,
  worldUsers,
  type DeliveryWorld,
  type Member,
} from "./report-delivery-helpers";

let app: Express;
let a: DeliveryWorld;
let b: DeliveryWorld;

const INCOME = "finance.income_statement";
const PER_EMPLOYEE = "sales.per_employee";

const exportAs = (m: Member | null, body: unknown, host = m?.host ?? a.host) =>
  (m?.client ?? agent(app))
    .post("/api/reports/exports")
    .set(originHeader)
    .set("Host", host)
    .send(body as object);
const getAs = (m: Member, path: string, host = m.host) =>
  m.client.get(path).set("Host", host);
const download = (m: Member, job: { id: string }, host = m.host) =>
  m.client
    .get(`/api/reports/exports/${job.id}/file`)
    .set("Host", host)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });

async function requested(
  m: Member,
  body: Record<string, unknown>,
): Promise<ReportExport> {
  const response = await exportAs(m, body);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return reportExportSchema.parse(response.body.data);
}

async function job(m: Member, id: string): Promise<ReportExport> {
  const response = await getAs(m, `/api/reports/exports/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return reportExportSchema.parse(response.body.data);
}

const sweep = (w: DeliveryWorld, now = new Date()) =>
  sweepReportExports(tenantContext(w.tenantId), now);

const incomeCsv = (extra: Record<string, unknown> = {}) => ({
  reportCode: INCOME,
  format: "csv",
  query: { period: JUNE, ...extra },
});

beforeAll(async () => {
  app = createApp();
  a = await makeDeliveryWorld(app, "ea");
  b = await makeDeliveryWorld(app, "eb");
  // WS-01 matrix row for personal-data exports: the full role approves.
  for (const w of [a, b])
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'personal_data_export', NULL, $2, 1)`,
      [w.tenantId, w.roles.full],
    );
});

afterAll(async () => {
  const users = [...worldUsers(a), ...worldUsers(b)];
  await owner.query("DELETE FROM report_exports WHERE requested_by = ANY($1)", [
    users,
  ]);
  await owner.query("DELETE FROM saved_reports WHERE owner_user_id = ANY($1)", [
    users,
  ]);
  await owner.end();
});

describe("POST /api/reports/exports: gate (DASH-04)", () => {
  it("answers 401 without a session", async () => {
    expect((await exportAs(null, incomeCsv())).status).toBe(401);
  });

  it("queues an aggregate export without an approval", async () => {
    const created = await requested(a.full, incomeCsv());
    expect(created.status).toBe("queued");
    expect(created.containsPersonalData).toBe(false);
    expect(created.approvalRequestId).toBeNull();
    expect(created.requestedBy).toBe(a.full.userId);
    expect(created.file).toBeNull();
  });

  it("refuses a caller without the export permission", async () => {
    expect((await exportAs(a.noExport, incomeCsv())).status).toBe(403);
  });

  it("refuses a caller without the report permission", async () => {
    expect((await exportAs(a.nobody, incomeCsv())).status).toBe(403);
  });

  it("refuses an outlet outside the caller's reach", async () => {
    const response = await exportAs(
      a.outletManager,
      incomeCsv({ outletIds: [a.outlet2] }),
    );
    expect(response.status).toBe(403);
  });

  it("answers 404 for an unknown report code", async () => {
    const response = await exportAs(a.full, {
      ...incomeCsv(),
      reportCode: "sales.does_not_exist",
    });
    expect(response.status).toBe(404);
  });

  it("refuses a containsPersonalData claim from the client", async () => {
    const response = await exportAs(a.full, {
      ...incomeCsv(),
      containsPersonalData: false,
    });
    expect([400, 422]).toContain(response.status);
  });

  it("replays an idempotency key instead of making a second job", async () => {
    const key = `exp-${randomUUID()}`;
    const first = await requested(a.full, {
      ...incomeCsv(),
      idempotencyKey: key,
    });
    const second = await requested(a.full, {
      ...incomeCsv(),
      idempotencyKey: key,
    });
    expect(second.id).toBe(first.id);
  });
});

describe("generation and download", () => {
  it("generates a CSV with the ledger figures and lets the requester download it", async () => {
    const created = await requested(a.full, incomeCsv({ groupBy: ["outlet"] }));
    await sweep(a);
    const ready = await job(a.full, created.id);
    expect(ready.status, JSON.stringify(ready)).toBe("ready");
    expect(ready.file?.downloadPath).toBe(
      `/api/reports/exports/${created.id}/file`,
    );
    expect(ready.file?.rowCount).toBe(2);
    const response = await download(a.full, created);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/csv/);
    expect(response.headers["content-disposition"]).toMatch(/^attachment/);
    const text = (response.body as Buffer).toString("utf8");
    expect(text).toContain("950000");
    expect(text).toContain("400000");
    expect(text).toContain("Outlet Dua");
  });

  it("renders XLSX and PDF files", async () => {
    const xlsx = await requested(a.full, { ...incomeCsv(), format: "xlsx" });
    const pdf = await requested(a.full, { ...incomeCsv(), format: "pdf" });
    await sweep(a);
    const x = await download(a.full, xlsx);
    expect(x.status).toBe(200);
    expect((x.body as Buffer).subarray(0, 2).toString("latin1")).toBe("PK");
    const p = await download(a.full, pdf);
    expect(p.status).toBe(200);
    expect((p.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("hides another user's job: 404 on read and download", async () => {
    const created = await requested(a.full, incomeCsv());
    await sweep(a);
    expect(
      (await getAs(a.peer, `/api/reports/exports/${created.id}`)).status,
    ).toBe(404);
    expect((await download(a.peer, created)).status).toBe(404);
    const page = reportExportPageSchema.parse(
      (await getAs(a.peer, "/api/reports/exports?limit=100")).body,
    );
    expect(page.data.map((row) => row.id)).not.toContain(created.id);
  });

  it("hides another tenant's job: 404 on read and download", async () => {
    const created = await requested(b.full, incomeCsv());
    await sweep(b);
    expect(
      (await getAs(a.full, `/api/reports/exports/${created.id}`)).status,
    ).toBe(404);
    expect((await download(a.full, created)).status).toBe(404);
  });

  it("fails the job when the requester lost the permission before generation", async () => {
    const created = await requested(a.noExport, incomeCsv()).catch(() => null);
    expect(created).toBeNull();
    const member = a.outletManager;
    const queued = await requested(member, incomeCsv());
    await owner.query(
      "UPDATE role_assignments SET valid_until = now() WHERE tenant_id = $1 AND user_id = $2",
      [a.tenantId, member.userId],
    );
    await sweep(a);
    const row = await owner.query(
      "SELECT status, error_code, file_content FROM report_exports WHERE id = $1",
      [queued.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error_code: "REPORT_NOT_PERMITTED",
      file_content: null,
    });
  });

  it("refuses the download once the requester's full permission is gone, even with the aggregate view left (404)", async () => {
    const created = await requested(a.peer, incomeCsv());
    await sweep(a);
    expect((await job(a.peer, created.id)).status).toBe("ready");
    await owner.query(
      "UPDATE roles SET permissions = permissions - 'report.financial.view' WHERE id = $1",
      [a.roles.full],
    );
    try {
      expect((await download(a.peer, created)).status).toBe(404);
    } finally {
      await owner.query(
        "UPDATE roles SET permissions = permissions || '[\"report.financial.view\"]'::jsonb WHERE id = $1",
        [a.roles.full],
      );
    }
  });

  it("expires the file after the retention window (410)", async () => {
    const created = await requested(a.full, incomeCsv());
    await sweep(a);
    await sweep(a, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    const expired = await job(a.full, created.id);
    expect(expired.status).toBe("expired");
    expect(expired.file).toBeNull();
    expect((await download(a.full, created)).status).toBe(410);
  });

  it("answers 409 before the file is ready", async () => {
    const created = await requested(a.full, incomeCsv());
    expect((await download(a.full, created)).status).toBe(409);
  });
});

describe("jobs stuck in generating (worker died)", () => {
  const state = (id: string) =>
    owner
      .query(
        "SELECT status, attempts, error_code, started_at FROM report_exports WHERE id = $1",
        [id],
      )
      .then((r) => r.rows[0]);
  const strand = (id: string, attempts: number, age: string) =>
    owner.query(
      `UPDATE report_exports SET status = 'generating', attempts = $2,
              started_at = now() - $3::interval WHERE id = $1`,
      [id, attempts, age],
    );

  it("puts a timed-out job back in the queue and finishes it", async () => {
    const created = await requested(a.full, incomeCsv());
    await strand(created.id, 1, "1 hour");
    await sweep(a);
    expect(await state(created.id)).toMatchObject({
      status: "ready",
      attempts: 2,
    });
  });

  it("fails a job whose attempts are used up, with no file", async () => {
    const created = await requested(a.full, incomeCsv());
    await strand(created.id, 3, "1 hour");
    await sweep(a);
    expect(await state(created.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      error_code: "REPORT_QUERY_INVALID",
    });
    expect((await download(a.full, created)).status).toBe(409);
  });

  it("leaves a job a live worker just started alone", async () => {
    const created = await requested(a.full, incomeCsv());
    await strand(created.id, 1, "1 minute");
    await sweep(a);
    expect(await state(created.id)).toMatchObject({
      status: "generating",
      attempts: 1,
    });
    await owner.query("UPDATE report_exports SET status = 'cancelled' WHERE id = $1", [created.id]);
  });
});

describe("saved-report exports", () => {
  it("exports the owner's saved query; another user gets 404", async () => {
    const saved = await a.full.client
      .post("/api/reports/saved")
      .set(originHeader)
      .set("Host", a.host)
      .send({
        name: "Penjualan bersih",
        query: { metricCodes: ["net_sales"], period: JUNE },
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const savedReportId = saved.body.data.id as string;
    const created = await requested(a.full, {
      savedReportId,
      format: "csv",
      query: { period: JUNE },
    });
    await sweep(a);
    expect((await job(a.full, created.id)).status).toBe("ready");
    const text = ((await download(a.full, created)).body as Buffer).toString(
      "utf8",
    );
    expect(text).toContain("1350000");
    const peer = await exportAs(a.peer, {
      savedReportId,
      format: "csv",
      query: { period: JUNE },
    });
    expect(peer.status).toBe(404);
  });
});

describe("personal-data exports need an approval (DASH-04)", () => {
  const perEmployee = {
    reportCode: PER_EMPLOYEE,
    format: "csv",
    query: { period: JUNE, groupBy: ["employee"] },
  };

  it("waits for approval with no file, then generates once approved", async () => {
    const created = await requested(a.full, perEmployee);
    expect(created.status).toBe("pending_approval");
    expect(created.containsPersonalData).toBe(true);
    expect(created.approvalRequestId).not.toBeNull();
    await sweep(a);
    expect((await job(a.full, created.id)).status).toBe("pending_approval");
    expect((await download(a.full, created)).status).toBe(409);
    await owner.query(
      "UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = now(), reason = 'Disetujui' WHERE chain_id = $1",
      [created.approvalRequestId, a.peer.userId],
    );
    await sweep(a);
    const done = await job(a.full, created.id);
    expect(done.status, JSON.stringify(done)).toBe("ready");
  });

  it("ends rejected when the approval is rejected", async () => {
    const created = await requested(a.full, perEmployee);
    await owner.query(
      "UPDATE approval_requests SET status = 'rejected', decided_by = $2, decided_at = now(), reason = 'Ditolak' WHERE chain_id = $1",
      [created.approvalRequestId, a.peer.userId],
    );
    await sweep(a);
    const done = await job(a.full, created.id);
    expect(done.status).toBe("rejected");
    expect(done.file).toBeNull();
  });

  it("never lets an aggregate-only caller export a person split", async () => {
    const response = await exportAs(a.shareholder, perEmployee);
    expect(response.status).toBe(403);
  });
});

describe("CSV formula injection", () => {
  const table = {
    title: "Uji",
    subtitle: "",
    header: ["outlet", "Penjualan (Rp)"],
    rows: [
      [
        { kind: "text" as const, value: '=HYPERLINK("http://x","klik")' },
        { kind: "number" as const, value: "-5000" },
      ],
      [
        { kind: "text" as const, value: "+62 811" },
        { kind: "number" as const, value: "12" },
      ],
      [
        { kind: "text" as const, value: "@SUM(A1)" },
        { kind: "empty" as const },
      ],
      [
        { kind: "text" as const, value: "-1+1" },
        { kind: "number" as const, value: "0" },
      ],
      [
        { kind: "text" as const, value: "\tcmd" },
        { kind: "number" as const, value: "1" },
      ],
    ],
  };

  it("prefixes text cells that start a formula, keeps numbers signed", () => {
    const lines = renderCsv(table)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split("\r\n");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://x"",""klik"")",-5000`);
    expect(lines[2]).toBe("'+62 811,12");
    expect(lines[3]).toBe("'@SUM(A1),");
    expect(lines[4]).toBe("'-1+1,0");
    expect(lines[5]).toBe("'\tcmd,1");
    expect(neutralizeFormula("Outlet Satu")).toBe("Outlet Satu");
  });

  it("writes XLSX text as inline strings with the same guard", () => {
    const xml = renderXlsx(table).toString("latin1");
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain("&apos;=HYPERLINK".replace("&apos;", "'"));
    expect(xml).not.toContain("<f>");
  });
});
