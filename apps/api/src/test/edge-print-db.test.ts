// Print Agent persistence (bead legend-46p; PRD v1.7 §3 F5 "Print Agent",
// EDG-05): queue order, idempotent enqueue, SKIP LOCKED claims, reroute, the
// immutable job content and forced tenant + outlet RLS on the three print
// tables. Stores run as the restricted legend_app login through withTenant;
// raw checks use legend_app with explicit settings, fixtures the migration
// owner (same approach as edge-db.test.ts).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import { createDbPrintStore, toPrintJobDto } from "../edge/print/store.ts";
import type { NewPrintJob, PrintStore } from "../edge/print/types.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const contextFor = (tenant: string, outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** Strictly increasing clock so created_at order equals enqueue order. */
let clockMs = Date.parse("2026-11-08T07:00:00.000Z");
const tick = () => new Date((clockMs += 1));

const storeFor = (tenant: string, outletId: string): PrintStore =>
  createDbPrintStore({ db, context: contextFor(tenant, outletId), now: tick });

async function withSettings<T>(
  role: "legend_app" | null,
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    const result = await run(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const asAppRole = <T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
) => withSettings("legend_app", settings, run);

/** Fixture writes as the migration owner (forced RLS still needs settings). */
const asOwner = <T>(run: (client: PoolClient) => Promise<T>) =>
  withSettings(null, { tenant: tenantId, outlets: "*" }, run, true);

async function insertPrinter(
  outletId: string,
  label: string,
  fallbackPrinterId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width, fallback_printer_id)
       VALUES ($1, $2, $3, $4, 'receipt', 'network', '192.168.1.50', 9100, 48, $5)`,
      [id, tenantId, outletId, label, fallbackPrinterId],
    ),
  );
  return id;
}

const job = (
  printerId: string,
  key: string,
  extra: Partial<NewPrintJob> = {},
): NewPrintJob => ({
  printerId,
  kind: "receipt",
  content: new Uint8Array([0x1b, 0x40, ...Buffer.from(key)]),
  idempotencyKey: `${key}-${randomUUID()}`,
  ...extra,
});

let storeA: PrintStore;
let storeB: PrintStore;
let storeOtherTenant: PrintStore;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  storeA = storeFor(tenantId, outletA);
  storeB = storeFor(tenantId, outletB);
  storeOtherTenant = storeFor(otherTenant, outletA);
});

afterAll(async () => {
  await owner.end();
});

describe("print store construction", () => {
  it("TEN-02 needs exactly one outlet in scope", () => {
    const wide = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    );
    expect(() => createDbPrintStore({ db, context: wide })).toThrow();
    const two = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      {
        kind: "outlets",
        outletIds: [
          outletIdSchema.parse(outletA),
          outletIdSchema.parse(outletB),
        ],
      },
    );
    expect(() => createDbPrintStore({ db, context: two })).toThrow();
  });
});

describe("print queue", () => {
  it("claims jobs oldest first per printer and walks the lifecycle", async () => {
    const printer = await insertPrinter(outletA, "Kasir order");
    const other = await insertPrinter(outletA, "Kasir lain");
    const first = (await storeA.enqueue(job(printer, "one"))).job;
    const second = (await storeA.enqueue(job(printer, "two"))).job;
    const third = (await storeA.enqueue(job(printer, "three"))).job;
    const elsewhere = (await storeA.enqueue(job(other, "elsewhere"))).job;
    expect(first.status).toBe("queued");
    expect(first.attempts).toBe(0);

    const claimed = await storeA.claimNext(printer);
    expect(claimed).toMatchObject({
      id: first.id,
      status: "printing",
      attempts: 1,
    });
    expect((await storeA.claimNext(printer))?.id).toBe(second.id);
    // The other printer's queue is independent.
    expect((await storeA.claimNext(other))?.id).toBe(elsewhere.id);

    await storeA.markPrinted(first.id, tick());
    expect((await storeA.getJob(first.id))?.status).toBe("printed");
    expect((await storeA.getJob(first.id))?.printedAt).toBeInstanceOf(Date);

    await storeA.markFailed(second.id, "x".repeat(900), "other");
    const failed = await storeA.getJob(second.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toHaveLength(500);
    expect(failed?.failurePhase).toBe("other");

    // A failed job returns to the queue behind older queued jobs only by age:
    // it is older than `third`, so it is claimed first again.
    const requeued = await storeA.requeue(second.id);
    expect(requeued.status).toBe("queued");
    expect(requeued.failurePhase).toBeNull();
    expect((await storeA.claimNext(printer))?.id).toBe(second.id);
    expect((await storeA.getJob(second.id))?.attempts).toBe(2);
    expect((await storeA.claimNext(printer))?.id).toBe(third.id);
    expect(await storeA.claimNext(printer)).toBeNull();
  });

  it("refuses invalid transitions with CONFLICT and unknown jobs with NOT_FOUND", async () => {
    const printer = await insertPrinter(outletA, "Transisi");
    const queued = (await storeA.enqueue(job(printer, "t"))).job;
    await expect(storeA.markPrinted(queued.id, tick())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      storeA.markFailed(queued.id, "err", "other"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(storeA.requeue(queued.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(storeA.requeue(createUlid())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(storeA.requeue("not-a-ulid")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      storeA.enqueue(job(randomUUID(), "ghost")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enqueue is idempotent on (outlet, idempotency key)", async () => {
    const printer = await insertPrinter(outletA, "Idempoten");
    const input = job(printer, "same");
    const created = await storeA.enqueue(input);
    const again = await storeA.enqueue({
      ...input,
      content: new Uint8Array([1, 2, 3]),
    });
    expect(created.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(created.job.id);
    // The original bytes win.
    expect(Array.from(again.job.content)).toEqual(Array.from(input.content));
    const claimedOnce = await storeA.claimNext(printer);
    expect(claimedOnce?.id).toBe(created.job.id);
    expect(await storeA.claimNext(printer)).toBeNull();
  });

  it("claim skips a job locked by another transaction (SKIP LOCKED)", async () => {
    const printer = await insertPrinter(outletA, "Skip locked");
    const first = (await storeA.enqueue(job(printer, "a"))).job;
    const second = (await storeA.enqueue(job(printer, "b"))).job;

    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE legend_app");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenantId, JSON.stringify([outletA])],
      );
      const locked = await holder.query(
        "SELECT id FROM edge_print_jobs WHERE printer_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE",
        [printer],
      );
      expect(locked.rows).toHaveLength(1);
      // The oldest job is locked, so the claim moves on to the next one.
      expect((await storeA.claimNext(printer))?.id).toBe(second.id);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await storeA.claimNext(printer))?.id).toBe(first.id);
  });

  it("two concurrent claims never return the same job", async () => {
    const printer = await insertPrinter(outletA, "Konkuren");
    await storeA.enqueue(job(printer, "c1"));
    await storeA.enqueue(job(printer, "c2"));
    const [x, y] = await Promise.all([
      storeA.claimNext(printer),
      storeA.claimNext(printer),
    ]);
    expect(x).not.toBeNull();
    expect(y).not.toBeNull();
    expect(x!.id).not.toBe(y!.id);
    expect(await storeA.claimNext(printer)).toBeNull();
  });

  it("reroutes queued jobs only and keeps the first printer", async () => {
    const fallback = await insertPrinter(outletA, "Cadangan");
    const middle = await insertPrinter(outletA, "Tengah", fallback);
    const main = await insertPrinter(outletA, "Utama", middle);
    const printing = (await storeA.enqueue(job(main, "p"))).job;
    const queued1 = (await storeA.enqueue(job(main, "q1"))).job;
    const queued2 = (await storeA.enqueue(job(main, "q2"))).job;
    expect((await storeA.claimNext(main))?.id).toBe(printing.id);

    expect(await storeA.reroute(main, middle)).toBe(2);
    const moved = await storeA.getJob(queued1.id);
    expect(moved).toMatchObject({
      printerId: middle,
      originalPrinterId: main,
      printedFallback: true,
      fallbackReason: "printer_offline",
    });
    // The job already printing stays where it is.
    expect((await storeA.getJob(printing.id))?.printerId).toBe(main);
    expect(await storeA.claimNext(main)).toBeNull();

    // A second hop keeps the first printer as the original.
    expect(await storeA.reroute(middle, fallback)).toBe(2);
    expect(await storeA.getJob(queued2.id)).toMatchObject({
      printerId: fallback,
      originalPrinterId: main,
    });
    expect((await storeA.claimNext(fallback))?.id).toBe(queued1.id);

    await expect(storeA.reroute(main, main)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(storeA.reroute(main, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("enqueue stores the original printer of a direct fallback job", async () => {
    const original = await insertPrinter(outletA, "Asal");
    const fallback = await insertPrinter(outletA, "Pengganti", null);
    const { job: stored } = await storeA.enqueue(
      job(fallback, "direct", {
        printedFallback: true,
        fallbackReason: "printer_offline",
        originalPrinterId: original,
      }),
    );
    expect(stored).toMatchObject({
      printerId: fallback,
      originalPrinterId: original,
      printedFallback: true,
      fallbackReason: "printer_offline",
    });
  });

  it("lists newest first with a stable cursor, status filter and DTO shape", async () => {
    const printer = await insertPrinter(outletA, "Daftar");
    const created = [];
    for (const key of ["l1", "l2", "l3", "l4", "l5"])
      created.push((await storeA.enqueue(job(printer, key))).job);
    await storeA.claimNext(printer);

    const mine = (items: { id: string; printerId: string }[]) =>
      items.filter((item) => item.printerId === printer);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await storeA.listJobs({ limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...mine(page.items).map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(created.map((item) => item.id).reverse());

    const printing = await storeA.listJobs({ status: "printing", limit: 200 });
    expect(mine(printing.items).map((item) => item.id)).toEqual([
      created[0]!.id,
    ]);

    await expect(
      storeA.listJobs({ limit: 5, cursor: "garbage" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const dto = toPrintJobDto(created[0]!);
    expect(dto).toMatchObject({
      tenantId,
      outletId: outletA,
      id: created[0]!.id,
      printerId: printer,
      kind: "receipt",
      format: "esc_pos",
      status: "queued",
      reprintOf: null,
    });
    expect(Buffer.from(dto.content ?? "", "base64")[0]).toBe(0x1b);
    expect(dto.createdAt).toBe(created[0]!.createdAt.toISOString());
  });

  it("keeps printer status and the start of an offline episode", async () => {
    const printer = await insertPrinter(outletA, "Status");
    const t1 = new Date("2026-11-08T08:00:00.000Z");
    const t2 = new Date("2026-11-08T08:00:30.000Z");
    const t3 = new Date("2026-11-08T08:05:00.000Z");
    await storeA.setPrinterStatus(printer, "offline", t1);
    await storeA.setPrinterStatus(printer, "offline", t2);
    expect(await storeA.getPrinter(printer)).toMatchObject({
      status: "offline",
      offlineSince: t1,
    });
    await storeA.setPrinterStatus(printer, "online", t3);
    expect(await storeA.getPrinter(printer)).toMatchObject({
      status: "online",
      lastSeenAt: t3,
      offlineSince: null,
      transport: { kind: "network", host: "192.168.1.50", port: 9100 },
      paperWidth: 48,
    });
    await expect(
      storeA.setPrinterStatus(randomUUID(), "online", t3),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records alerts for a printer, a station and a job (ULID subject)", async () => {
    const printer = await insertPrinter(outletA, "Alert");
    const printed = (await storeA.enqueue(job(printer, "alert"))).job;
    const station = randomUUID();
    const at = new Date("2026-11-08T09:00:00.000Z");
    await storeA.recordAlert({
      kind: "printer_offline",
      subjectId: printer,
      stationId: null,
      detail: { movedJobs: 2 },
      occurredAt: at,
    });
    await storeA.recordAlert({
      kind: "kds_down",
      subjectId: station,
      stationId: station,
      detail: {},
      occurredAt: at,
    });
    await storeA.recordAlert({
      kind: "job_failed",
      subjectId: printed.id,
      stationId: null,
      detail: { attempts: 1 },
      occurredAt: at,
    });
    const rows = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      (client) =>
        client.query(
          "SELECT kind, subject_id, detail FROM edge_print_alerts WHERE subject_id = ANY($1::uuid[]) ORDER BY kind",
          [[printer, station, "00000000-0000-0000-0000-000000000000"]],
        ),
    );
    expect(rows.rows.map((row) => row.kind)).toEqual([
      "kds_down",
      "printer_offline",
    ]);
    expect(rows.rows[1].detail).toEqual({ movedJobs: 2 });
    const jobAlert = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      (client) =>
        client.query(
          "SELECT kind FROM edge_print_alerts WHERE kind = 'job_failed' AND detail @> '{\"attempts\": 1}'",
        ),
    );
    expect(jobAlert.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("releaseClaim puts a printing job back in the queue and ignores other states", async () => {
    const printer = await insertPrinter(outletA, "Lepas klaim");
    const queued = (await storeA.enqueue(job(printer, "rel-q"))).job;
    const claimed = await storeA.claimNext(printer);
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.attempts).toBe(1);

    await storeA.releaseClaim(queued.id, "e".repeat(900));
    const released = await storeA.getJob(queued.id);
    expect(released).toMatchObject({ status: "queued", attempts: 1 });
    expect(released?.lastError).toHaveLength(500);
    const rawStartedAt = (
      await asOwner((client) =>
        client.query("SELECT started_at FROM edge_print_jobs WHERE id = $1", [
          ulidToUuid(queued.id),
        ]),
      )
    ).rows[0].started_at;
    expect(rawStartedAt).toBeNull();

    // Claimable again; releasing a job that is no longer printing is a no-op.
    expect((await storeA.claimNext(printer))?.id).toBe(queued.id);
    await storeA.markPrinted(queued.id, tick());
    await storeA.releaseClaim(queued.id, "terlambat");
    expect(await storeA.getJob(queued.id)).toMatchObject({
      status: "printed",
      lastError: null,
    });
    // Another outlet's store never touches this job.
    const second = (await storeA.enqueue(job(printer, "rel-b"))).job;
    await storeA.claimNext(printer);
    await storeB.releaseClaim(second.id, "bukan outlet ini");
    expect((await storeA.getJob(second.id))?.status).toBe("printing");
  });

  it("failStaleClaims fails only printing jobs claimed before the cutoff", async () => {
    const printer = await insertPrinter(outletA, "Klaim basi");
    const stale = (await storeA.enqueue(job(printer, "st-old"))).job;
    const done = (await storeA.enqueue(job(printer, "st-done"))).job;
    const waiting = (await storeA.enqueue(job(printer, "st-wait"))).job;
    const fresh = (await storeA.enqueue(job(printer, "st-new"))).job;
    expect((await storeA.claimNext(printer))?.id).toBe(stale.id);
    expect((await storeA.claimNext(printer))?.id).toBe(done.id);
    await storeA.markPrinted(done.id, tick());
    const cutoff = tick();
    expect((await storeA.claimNext(printer))?.id).toBe(waiting.id);
    expect((await storeA.claimNext(printer))?.id).toBe(fresh.id);
    // `waiting` and `fresh` were claimed after the cutoff; put one back.
    await storeA.releaseClaim(waiting.id, "kembali");

    // Another outlet's store cannot reach these claims (outlet B must stay
    // empty for the isolation test).
    expect(
      await storeB.failStaleClaims(new Date(cutoff.getTime() + 1_000), "x"),
    ).toEqual([]);

    // The test database is shared: only look at this test's printer.
    const failed = (
      await storeA.failStaleClaims(
        new Date(cutoff.getTime() + 1),
        "k".repeat(900),
      )
    ).filter((item) => item.printerId === printer);
    // Only the printing jobs started before the cutoff: `stale`.
    expect(failed.map((item) => item.id)).toEqual([stale.id]);
    expect(failed[0]).toMatchObject({
      status: "failed",
      failurePhase: "stale",
    });
    expect(failed[0]?.lastError).toHaveLength(500);

    expect((await storeA.getJob(stale.id))?.status).toBe("failed");
    expect((await storeA.getJob(done.id))?.status).toBe("printed");
    expect((await storeA.getJob(waiting.id))?.status).toBe("queued");
    expect((await storeA.getJob(fresh.id))?.status).toBe("printing");
    expect(
      await storeA.failStaleClaims(new Date(cutoff.getTime() + 1), "x"),
    ).toEqual([]);
  });

  it("markFailed records the write phase and requeue / releaseClaim clear it", async () => {
    const printer = await insertPrinter(outletA, "Fase gagal");
    const written = (await storeA.enqueue(job(printer, "ph-w"))).job;
    await storeA.claimNext(printer);
    await storeA.markFailed(written.id, "write error", "write");
    expect(await storeA.getJob(written.id)).toMatchObject({
      status: "failed",
      failurePhase: "write",
    });
    expect((await storeA.requeue(written.id)).failurePhase).toBeNull();
    // A claimed job released back to the queue never keeps a phase.
    await storeA.claimNext(printer);
    await storeA.releaseClaim(written.id, "connect error");
    expect(await storeA.getJob(written.id)).toMatchObject({
      status: "queued",
      failurePhase: null,
    });
  });

  it("CHECK keeps failure_phase set exactly while the job is failed", async () => {
    const printer = await insertPrinter(outletA, "Cek fase");
    const insert = (status: string, phase: string | null) =>
      asOwner((client) =>
        client.query(
          `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key, status, failure_phase, printed_at)
           VALUES ($1, $2, $3, $4, 'receipt', '\\x1b40', $5, $6, $7, NULL)`,
          [
            randomUUID(),
            tenantId,
            outletA,
            printer,
            `ph-${randomUUID()}`,
            status,
            phase,
          ],
        ),
      );
    await expect(insert("failed", null)).rejects.toThrow(
      /edge_print_jobs_failure_phase_status_check/,
    );
    await expect(insert("queued", "write")).rejects.toThrow(
      /edge_print_jobs_failure_phase_status_check/,
    );
    await expect(insert("failed", "bogus")).rejects.toThrow(
      /edge_print_jobs_failure_phase_check/,
    );
    await expect(insert("failed", "stale")).resolves.toBeDefined();
    await expect(insert("queued", null)).resolves.toBeDefined();
  });

  it("CHECK refuses a fallback job without a reason and a reason without fallback", async () => {
    const printer = await insertPrinter(outletA, "Cek fallback");
    const insert = (printedFallback: boolean, reason: string | null) =>
      asOwner((client) =>
        client.query(
          `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key, printed_fallback, fallback_reason)
           VALUES ($1, $2, $3, $4, 'receipt', '\\x1b40', $5, $6, $7)`,
          [
            randomUUID(),
            tenantId,
            outletA,
            printer,
            `chk-${randomUUID()}`,
            printedFallback,
            reason,
          ],
        ),
      );
    await expect(insert(true, null)).rejects.toThrow(
      /edge_print_jobs_fallback_check/,
    );
    await expect(insert(true, "bogus")).rejects.toThrow(
      /edge_print_jobs_fallback_check/,
    );
    await expect(insert(false, "kds_down")).rejects.toThrow(
      /edge_print_jobs_fallback_check/,
    );
    await expect(insert(true, "printer_offline")).resolves.toBeDefined();
    await expect(insert(false, null)).resolves.toBeDefined();
  });

  it("listJobs refuses a well-formed cursor with an out-of-range date or a bad id", async () => {
    const encode = (iso: string, id: string) =>
      Buffer.from(`${iso}|${id}`).toString("base64url");
    const goodId = createUlid();
    const bad = [
      encode("+275760-09-13T00:00:00.000Z", goodId),
      encode("-000001-01-01T00:00:00.000Z", goodId),
      encode("+010000-01-01T00:00:00.000Z", goodId),
      encode("2026-13-45T99:00:00.000Z", goodId),
      encode("2026-11-08T07:00:00.000Z", "not-a-ulid"),
      encode("2026-11-08T07:00:00.000Z", "8ZZZZZZZZZZZZZZZZZZZZZZZZZ"),
      encode("2026-11-08T07:00:00.000Z", ""),
      encode("2026-11-08T07:00:00.000Z", `${goodId}|extra`),
    ];
    for (const cursor of bad)
      await expect(storeA.listJobs({ limit: 5, cursor })).rejects.toMatchObject(
        {
          code: "VALIDATION_ERROR",
          message: "Kursor tidak valid.",
        },
      );
    // A good cursor still works.
    await expect(
      storeA.listJobs({
        limit: 5,
        cursor: encode("2026-11-08T07:00:00.000Z", goodId),
      }),
    ).resolves.toHaveProperty("items");
  });
});

describe("print tables isolation", () => {
  it("TEN-02 TEN-03 other tenant and other outlet see and claim nothing", async () => {
    const printer = await insertPrinter(outletA, "Terisolasi");
    const secret = (await storeA.enqueue(job(printer, "iso"))).job;
    await storeA.recordAlert({
      kind: "printer_offline",
      subjectId: printer,
      stationId: null,
      detail: {},
      occurredAt: tick(),
    });

    for (const foreign of [storeB, storeOtherTenant]) {
      expect(await foreign.getPrinter(printer)).toBeNull();
      expect(
        (await foreign.listPrinters()).map((item) => item.id),
      ).not.toContain(printer);
      expect(await foreign.getJob(secret.id)).toBeNull();
      expect(
        (await foreign.listJobs({ limit: 200 })).items.map((item) => item.id),
      ).not.toContain(secret.id);
      expect(await foreign.claimNext(printer)).toBeNull();
      await expect(
        foreign.markFailed(secret.id, "x", "other"),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(foreign.requeue(secret.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        foreign.enqueue(job(printer, "intrusion")),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        foreign.setPrinterStatus(printer, "offline", tick()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        foreign.reroute(printer, randomUUID()),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    // The owner outlet still has its untouched queued job.
    expect((await storeA.getJob(secret.id))?.status).toBe("queued");

    const tables = ["edge_printers", "edge_print_jobs", "edge_print_alerts"];
    const visible = (settings: { tenant: string; outlets: string }) =>
      asAppRole(settings, async (client) =>
        Promise.all(
          tables.map(async (name) => {
            const result = await client.query(
              `SELECT count(*)::int AS n FROM ${name}`,
            );
            return result.rows[0].n as number;
          }),
        ),
      );
    const own = await visible({
      tenant: tenantId,
      outlets: JSON.stringify([outletA]),
    });
    expect(own.every((count) => count >= 1)).toBe(true);
    expect(
      await visible({ tenant: tenantId, outlets: JSON.stringify([outletB]) }),
    ).toEqual([0, 0, 0]);
    expect(await visible({ tenant: otherTenant, outlets: "*" })).toEqual([
      0, 0, 0,
    ]);
  });

  it("TEN-02 RLS refuses a write into another tenant or outlet", async () => {
    const printer = await insertPrinter(outletA, "Tulis");
    const insertJob = (
      settings: { tenant: string; outlets: string },
      tenantValue: string,
      outletValue: string,
    ) =>
      asAppRole(settings, (client) =>
        client.query(
          `INSERT INTO edge_print_jobs (id, tenant_id, outlet_id, printer_id, kind, content, idempotency_key)
           VALUES ($1, $2, $3, $4, 'receipt', '\\x1b40', $5)`,
          [randomUUID(), tenantValue, outletValue, printer, randomUUID()],
        ),
      );
    await expect(
      insertJob(
        { tenant: tenantId, outlets: JSON.stringify([outletB]) },
        tenantId,
        outletA,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      insertJob({ tenant: otherTenant, outlets: "*" }, tenantId, outletA),
    ).rejects.toThrow(/row-level security/);
  });

  it("TEN-01 TEN-03 print tables have forced restrictive tenant and outlet policies", async () => {
    const names = ["edge_print_alerts", "edge_print_jobs", "edge_printers"];
    const result = await owner.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [names],
    );
    expect(result.rows).toEqual(
      names.map((name) => ({
        name,
        enabled: true,
        forced: true,
        tenant: true,
        outlet: true,
      })),
    );
  });
});

describe("printer target CHECKs", () => {
  const insertTarget = (
    transport: "network" | "usb",
    host: string | null,
    port: number | null,
    devicePath: string | null,
  ) =>
    asOwner((client) =>
      client.query(
        `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port, device_path, paper_width)
         VALUES ($1, $2, $3, 'Target', 'receipt', $4, $5, $6, $7, 48)`,
        [randomUUID(), tenantId, outletA, transport, host, port, devicePath],
      ),
    );

  it("refuses a device path outside /dev/usb/lpN and /dev/lpN", async () => {
    for (const path of [
      "/etc/passwd",
      "/dev/sda",
      "/dev/usb/lp",
      "/dev/usb/lp0/../sda",
      "/dev/lp0x",
      "dev/usb/lp0",
    ])
      await expect(insertTarget("usb", null, null, path)).rejects.toThrow(
        /edge_printers_device_path_check/,
      );
    await expect(
      insertTarget("usb", null, null, "/dev/usb/lp0"),
    ).resolves.toBeDefined();
    await expect(
      insertTarget("usb", null, null, "/dev/lp1"),
    ).resolves.toBeDefined();
  });

  it("refuses a port outside 9100-9102", async () => {
    for (const port of [9099, 9103, 9200, 80, 65535])
      await expect(
        insertTarget("network", "192.168.1.50", port, null),
      ).rejects.toThrow(/edge_printers_port_check/);
    for (const port of [9100, 9101, 9102])
      await expect(
        insertTarget("network", "192.168.1.50", port, null),
      ).resolves.toBeDefined();
  });

  it("refuses a host that is not a private LAN IPv4 literal", async () => {
    for (const host of [
      "127.0.0.1",
      "169.254.1.1",
      "printer.local",
      "8.8.8.8",
      "172.32.0.1",
      "999.1.1.1",
      "192.168.1",
      "192.168.1.50/24",
      "::1",
      "",
    ])
      await expect(insertTarget("network", host, 9100, null)).rejects.toThrow(
        /edge_printers_host_check/,
      );
    for (const host of [
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.1.50",
    ])
      await expect(
        insertTarget("network", host, 9100, null),
      ).resolves.toBeDefined();
  });
});

describe("print job immutability", () => {
  it("refuses changes to content, kind, idempotency key, reprint link and created_at", async () => {
    const printer = await insertPrinter(outletA, "Beku");
    const original = (await storeA.enqueue(job(printer, "frozen"))).job;
    const reprint = (
      await storeA.enqueue(job(printer, "again", { reprintOf: original.id }))
    ).job;
    expect(reprint.reprintOf).toBe(original.id);

    const attempt = (sqlText: string, params: unknown[]) =>
      asAppRole(
        { tenant: tenantId, outlets: JSON.stringify([outletA]) },
        (client) => client.query(sqlText, params),
      );
    const id = (
      await asOwner((client) =>
        client.query(
          "SELECT id FROM edge_print_jobs WHERE printer_id = $1 ORDER BY created_at LIMIT 1",
          [printer],
        ),
      )
    ).rows[0].id;
    await expect(
      attempt("UPDATE edge_print_jobs SET content = '\\x00' WHERE id = $1", [
        id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      attempt(
        "UPDATE edge_print_jobs SET kind = 'shift_report' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      attempt(
        "UPDATE edge_print_jobs SET idempotency_key = 'other' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      attempt(
        "UPDATE edge_print_jobs SET reprint_of = NULL WHERE printer_id = $1 AND reprint_of IS NOT NULL",
        [printer],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      attempt("UPDATE edge_print_jobs SET created_at = now() WHERE id = $1", [
        id,
      ]),
    ).rejects.toThrow(/immutable/);
    // Status and error text stay writable.
    await expect(
      attempt("UPDATE edge_print_jobs SET last_error = 'ok' WHERE id = $1", [
        id,
      ]),
    ).resolves.toBeDefined();
  });

  it("keeps alerts append-only except acknowledgement", async () => {
    const printer = await insertPrinter(outletA, "Alert beku");
    await storeA.recordAlert({
      kind: "printer_offline",
      subjectId: printer,
      stationId: null,
      detail: {},
      occurredAt: tick(),
    });
    const attempt = (sqlText: string, params: unknown[]) =>
      asAppRole(
        { tenant: tenantId, outlets: JSON.stringify([outletA]) },
        (client) => client.query(sqlText, params),
      );
    await expect(
      attempt(
        "UPDATE edge_print_alerts SET kind = 'printer_online' WHERE subject_id = $1",
        [printer],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      attempt(
        "UPDATE edge_print_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE subject_id = $1",
        [printer, randomUUID()],
      ),
    ).resolves.toBeDefined();
  });
});

describe("legend-z76q station printer dispatch", () => {
  it.each([
    "revoked",
    "other outlet",
    "wrong type",
    "inactive",
    "receipt revoked",
  ])("does not send a queued job when its device is %s", async (invalid) => {
    const printerId = randomUUID();
    const stationId = randomUUID();
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status)
           VALUES ($1, $2, $3, $4, 'Dispatch test', 'active')`,
        [
          printerId,
          tenantId,
          invalid === "other outlet" ? outletB : outletA,
          invalid === "wrong type" ? "pos" : "printer",
        ],
      );
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type, printer_device_id)
           VALUES ($1, $2, $3, $5, 'hot_kitchen', $4)`,
        [stationId, tenantId, outletA, printerId, `Dispatch ${stationId}`],
      );
      await client.query(
        `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, station_id, transport, host, port)
           VALUES ($1, $2, $3, 'Dispatch test', 'station', $4, 'network', '192.168.1.50', 9100)`,
        [printerId, tenantId, outletA, stationId],
      );
    });
    const queued = await storeA.enqueue(
      job(printerId, `dispatch-${invalid}`, {
        kind: invalid === "receipt revoked" ? "receipt" : "station_ticket",
      }),
    );
    await asOwner(async (client) => {
      if (
        invalid === "revoked" ||
        invalid === "inactive" ||
        invalid === "receipt revoked"
      )
        await client.query(
          "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
          [printerId],
        );
    });
    const transport = new FakePrinterTransport();
    const agent = createPrintAgent({
      store: storeA,
      transportFor: () => transport,
    });
    await agent.drain(printerId);
    expect(transport.printed).toHaveLength(0);
    const result = await asOwner((client) =>
      client.query<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM edge_print_jobs WHERE id = $1",
        [ulidToUuid(queued.job.id)],
      ),
    );
    expect(result.rows[0]?.status).toBe("failed");
    expect(result.rows[0]?.last_error).toBeTruthy();
  });

  it.each([
    "valid",
    "binding changed",
    "fallback valid",
    "fallback revoked",
    "fallback receipt original revoked",
  ])(
    "checks the station binding and actual destination: %s",
    async (scenario) => {
      const stationPrinter = randomUUID();
      const stationId = randomUUID();
      const fallback = randomUUID();
      const usesFallback = scenario.startsWith("fallback");
      await asOwner(async (client) => {
        for (const id of usesFallback
          ? [stationPrinter, fallback]
          : [stationPrinter]) {
          await client.query(
            `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status)
             VALUES ($1, $2, $3, 'printer', 'Dispatch test', 'active')`,
            [id, tenantId, outletA],
          );
        }
        await client.query(
          `INSERT INTO stations (id, tenant_id, outlet_id, name, type, printer_device_id)
           VALUES ($1, $2, $3, $4, 'hot_kitchen', $5)`,
          [
            stationId,
            tenantId,
            outletA,
            `Dispatch ${stationId}`,
            stationPrinter,
          ],
        );
        await client.query(
          `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, station_id, transport, host, port)
           VALUES ($1, $2, $3, 'Station test', 'station', $4, 'network', '192.168.1.50', 9100)`,
          [stationPrinter, tenantId, outletA, stationId],
        );
        if (usesFallback)
          await client.query(
            `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port)
             VALUES ($1, $2, $3, 'Fallback test', 'receipt', 'network', '192.168.1.51', 9100)`,
            [fallback, tenantId, outletA],
          );
      });
      const target = usesFallback ? fallback : stationPrinter;
      const queued = await storeA.enqueue(
        job(target, `dispatch-${scenario}`, {
          kind:
            scenario === "fallback receipt original revoked"
              ? "receipt"
              : "station_ticket",
          ...(usesFallback
            ? {
                printedFallback: true,
                fallbackReason: "printer_offline",
                originalPrinterId: stationPrinter,
              }
            : {}),
        }),
      );
      await asOwner(async (client) => {
        if (scenario === "binding changed")
          await client.query(
            "UPDATE stations SET printer_device_id = NULL WHERE id = $1",
            [stationId],
          );
        if (
          scenario === "fallback revoked" ||
          scenario === "fallback receipt original revoked"
        )
          await client.query(
            "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
            [scenario === "fallback revoked" ? fallback : stationPrinter],
          );
      });
      const transport = new FakePrinterTransport();
      const agent = createPrintAgent({
        store: storeA,
        transportFor: () => transport,
      });
      await agent.drain(target);
      const allowed = scenario === "valid" || scenario === "fallback valid";
      expect(transport.printed).toHaveLength(allowed ? 1 : 0);
      const result = await asOwner((client) =>
        client.query<{ status: string }>(
          "SELECT status FROM edge_print_jobs WHERE id = $1",
          [ulidToUuid(queued.job.id)],
        ),
      );
      expect(result.rows[0]?.status).toBe(allowed ? "printed" : "failed");
    },
  );
});
