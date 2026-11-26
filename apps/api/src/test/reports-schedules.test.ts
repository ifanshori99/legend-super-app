// Fail-first tests for report delivery schedules (WS-11 F12, bead
// legend-ay6e6). Contract: reportScheduleSchema / reportScheduleGate in
// packages/shared/src/dashboard/builder.ts and exports.ts. CTO 27 Nov: a v1
// schedule produces a run + a downloadable file + an in-app notification
// (email when the channel exists), no WhatsApp; data only for recipients who
// may read that report; another user's / tenant's schedule is a 404.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  reportExportPageSchema,
  reportScheduleSchema,
  savedReportSchema,
} from "@starter/shared/dashboard";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { createNotificationConsumer } from "../services/notification-consumer";
import { sweepReportExports } from "../services/report-exports.service";
import {
  localDate,
  nextRunAfter,
  rolledPeriod,
  runDueReportSchedules,
} from "../services/report-schedules.service";
import { createNotificationRecipientResolver } from "../worker/notification-adapters";
import { originHeader } from "./helpers";
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

const send = (
  m: Member,
  method: "post" | "patch",
  path: string,
  body: unknown,
) =>
  m.client[method](path)
    .set(originHeader)
    .set("Host", m.host)
    .send(body as object);

async function savedFor(m: Member, query: Record<string, unknown>) {
  const response = await send(m, "post", "/api/reports/saved", {
    name: "Penjualan harian",
    query: { metricCodes: ["net_sales"], period: JUNE, ...query },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return savedReportSchema.parse(response.body.data);
}

const daily = (savedReportId: string, recipientUserIds: string[]) => ({
  savedReportId,
  frequency: "daily",
  timeOfDay: "07:00",
  format: "csv",
  recipientUserIds,
});

async function scheduleFor(m: Member, recipients: string[]) {
  const saved = await savedFor(m, { groupBy: ["outlet"] });
  const response = await send(
    m,
    "post",
    "/api/reports/schedules",
    daily(saved.id, recipients),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return reportScheduleSchema.parse(response.body.data);
}

async function makeDue(scheduleId: string) {
  await owner.query(
    "UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1",
    [scheduleId],
  );
}

async function jobsOf(scheduleId: string) {
  const result = await owner.query<{
    id: string;
    requested_by: string;
    status: string;
    query: { period: { startDate: string; endDate: string } };
  }>(
    "SELECT id, requested_by, status, query FROM report_exports WHERE schedule_id = $1 ORDER BY requested_by",
    [scheduleId],
  );
  return result.rows;
}

beforeAll(async () => {
  app = createApp();
  a = await makeDeliveryWorld(app, "ja");
  b = await makeDeliveryWorld(app, "jb");
});

afterAll(async () => {
  const users = [...worldUsers(a), ...worldUsers(b)];
  await owner.query("DELETE FROM report_exports WHERE requested_by = ANY($1)", [
    users,
  ]);
  await owner.query(
    "DELETE FROM report_schedules WHERE owner_user_id = ANY($1)",
    [users],
  );
  await owner.query("DELETE FROM saved_reports WHERE owner_user_id = ANY($1)", [
    users,
  ]);
  await owner.end();
});

describe("schedule clock", () => {
  it("finds the next daily, weekly and monthly slot in the outlet time zone", () => {
    const after = new Date("2026-11-27T01:00:00Z"); // 08:00 WIB, Friday
    const at = (c: Parameters<typeof nextRunAfter>[0]) =>
      nextRunAfter(c, "Asia/Jakarta", after).toISOString();
    expect(
      at({
        frequency: "daily",
        timeOfDay: "07:00",
        dayOfWeek: null,
        dayOfMonth: null,
      }),
    ).toBe("2026-11-28T00:00:00.000Z");
    expect(
      at({
        frequency: "daily",
        timeOfDay: "09:30",
        dayOfWeek: null,
        dayOfMonth: null,
      }),
    ).toBe("2026-11-27T02:30:00.000Z");
    expect(
      at({
        frequency: "weekly",
        timeOfDay: "07:00",
        dayOfWeek: 1,
        dayOfMonth: null,
      }),
    ).toBe("2026-11-30T00:00:00.000Z");
    expect(
      at({
        frequency: "monthly",
        timeOfDay: "07:00",
        dayOfWeek: null,
        dayOfMonth: 1,
      }),
    ).toBe("2026-12-01T00:00:00.000Z");
  });

  it("rolls the saved period to end the day before the run", () => {
    const slot = new Date("2026-11-28T00:00:00Z");
    expect(rolledPeriod(JUNE, slot, "Asia/Jakarta")).toEqual({
      startDate: "2026-10-29", // same 30-day length as JUNE
      endDate: "2026-11-27",
    });
    expect(
      rolledPeriod(
        { startDate: "2025-06-10", endDate: "2025-06-10" },
        slot,
        "Asia/Jakarta",
      ),
    ).toEqual({ startDate: "2026-11-27", endDate: "2026-11-27" });
  });
});

describe("POST/PATCH /api/reports/schedules", () => {
  it("creates a schedule on the owner's saved report with a future nextRunAt", async () => {
    const schedule = await scheduleFor(a.full, [a.full.userId, a.peer.userId]);
    expect(schedule.isEnabled).toBe(true);
    expect(schedule.tenantId).toBe(a.tenantId);
    expect(Date.parse(schedule.nextRunAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("answers 404 for a peer's saved report", async () => {
    const saved = await savedFor(a.peer, {});
    const response = await send(
      a.full,
      "post",
      "/api/reports/schedules",
      daily(saved.id, [a.full.userId]),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a schedule on an archived saved report", async () => {
    const saved = await savedFor(a.full, { groupBy: ["outlet"] });
    await owner.query(
      "UPDATE saved_reports SET status = 'archived' WHERE id = $1",
      [saved.id],
    );
    const response = await send(
      a.full,
      "post",
      "/api/reports/schedules",
      daily(saved.id, [a.full.userId]),
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "REPORT_SCHEDULE_INVALID",
    );
  });

  it("refuses a saved query split by a person (DASH-04)", async () => {
    const saved = await savedFor(a.full, { groupBy: ["employee"] });
    const response = await send(
      a.full,
      "post",
      "/api/reports/schedules",
      daily(saved.id, [a.full.userId]),
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("EXPORT_PII_APPROVAL_REQUIRED");
  });

  it("refuses a recipient who may not read the report", async () => {
    const saved = await savedFor(a.full, {});
    for (const recipient of [a.nobody, a.noExport, b.full]) {
      const response = await send(
        a.full,
        "post",
        "/api/reports/schedules",
        daily(saved.id, [recipient.userId]),
      );
      expect(response.status, recipient.email).toBe(400);
    }
  });

  it("answers 404 to another user or tenant on PATCH", async () => {
    const schedule = await scheduleFor(a.full, [a.full.userId]);
    const body = {
      frequency: "daily",
      timeOfDay: "08:00",
      format: "csv",
      recipientUserIds: [a.full.userId],
      isEnabled: false,
    };
    const path = `/api/reports/schedules/${schedule.id}`;
    expect((await send(a.peer, "patch", path, body)).status).toBe(404);
    expect((await send(b.full, "patch", path, body)).status).toBe(404);
    const own = await send(a.full, "patch", path, body);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const updated = reportScheduleSchema.parse(own.body.data);
    expect(updated.isEnabled).toBe(false);
    expect(updated.nextRunAt).toBeNull();
  });
});

describe("a due schedule delivers files and notifications", () => {
  it("makes one job per recipient under the recipient's own access, once per slot", async () => {
    const schedule = await scheduleFor(a.full, [
      a.full.userId,
      a.outletManager.userId,
    ]);
    await makeDue(schedule.id);
    const ctx = tenantContext(a.tenantId);
    const run = await runDueReportSchedules(ctx);
    expect(run.jobs).toBe(2);
    expect((await runDueReportSchedules(ctx)).jobs).toBe(0);
    await sweepReportExports(ctx);
    const jobs = await jobsOf(schedule.id);
    expect(jobs.map((j) => j.status)).toEqual(["ready", "ready"]);
    const yesterday = localDate(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      "Asia/Jakarta",
    );
    for (const j of jobs) expect(j.query.period.endDate).toBe(yesterday);

    // Each recipient lists and downloads only their own job.
    const managerJob = jobs.find(
      (j) => j.requested_by === a.outletManager.userId,
    );
    const fullJob = jobs.find((j) => j.requested_by === a.full.userId);
    const page = reportExportPageSchema.parse(
      (
        await a.outletManager.client
          .get("/api/reports/exports?limit=100")
          .set("Host", a.host)
      ).body,
    );
    const ids = page.data.map((row) => row.id);
    expect(ids).toContain(managerJob?.id);
    expect(ids).not.toContain(fullJob?.id);
    expect(
      (
        await a.outletManager.client
          .get(`/api/reports/exports/${fullJob?.id}/file`)
          .set("Host", a.host)
      ).status,
    ).toBe(404);
    // The outlet manager's file covers outlet1 only.
    const row = await owner.query<{ outlet_ids: unknown }>(
      "SELECT outlet_ids FROM report_exports WHERE id = $1",
      [managerJob?.id],
    );
    expect(row.rows[0]?.outlet_ids).toEqual([a.outlet1]);

    // Notification: in-app (and email when configured), no figures.
    const events = await owner.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'notification'
          AND event ->> 'name' = 'report_export.delivered'
          AND aggregate_id = ANY($2::uuid[])`,
      [a.tenantId, jobs.map((j) => j.id)],
    );
    expect(events.rows).toHaveLength(2);
    const deliver = createNotificationConsumer(
      ctx,
      createNotificationRecipientResolver({ email: true, push: false }),
    );
    for (const { event } of events.rows)
      await withTenant(db, ctx, (tx) =>
        deliver(event as never, String(event.idempotencyKey), tx as never),
      );
    const notes = await owner.query<{
      user_id: string;
      category: string;
      title: string;
      body: string;
    }>(
      `SELECT user_id::text, category, title, body FROM notifications
        WHERE tenant_id = $1 AND category = 'report_delivery'
          AND user_id = ANY($2::uuid[])`,
      [a.tenantId, [a.full.userId, a.outletManager.userId]],
    );
    expect(notes.rows.map((n) => n.user_id).sort()).toEqual(
      [a.full.userId, a.outletManager.userId].sort(),
    );
    for (const note of notes.rows) {
      expect(note.title).toContain("Penjualan harian");
      expect(note.body).not.toMatch(/950|400|1\.?350/);
    }
  });

  it("skips a recipient who lost the permission by run time", async () => {
    const schedule = await scheduleFor(a.peer, [a.peer.userId]);
    await owner.query(
      "UPDATE report_schedules SET recipient_user_ids = $2::jsonb WHERE id = $1",
      [schedule.id, JSON.stringify([a.peer.userId, a.noExport.userId])],
    );
    await makeDue(schedule.id);
    const run = await runDueReportSchedules(tenantContext(a.tenantId));
    expect(run.jobs).toBe(1);
    expect(run.skippedRecipients).toBe(1);
    const jobs = await jobsOf(schedule.id);
    expect(jobs.map((j) => j.requested_by)).toEqual([a.peer.userId]);
  });

  it("pauses a schedule whose owner is blocked and tells the tenant admins", async () => {
    const schedule = await scheduleFor(a.peer, [a.full.userId]);
    await makeDue(schedule.id);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      a.peer.userId,
    ]);
    await owner.query(
      "UPDATE roles SET permissions = permissions || '[\"org.settings.manage\"]'::jsonb WHERE id = $1",
      [a.roles.full],
    );
    const ctx = tenantContext(a.tenantId);
    try {
      const run = await runDueReportSchedules(ctx);
      expect(run.jobs).toBe(0);
      expect(await jobsOf(schedule.id)).toHaveLength(0);
      const row = await owner.query(
        "SELECT is_enabled, next_run_at FROM report_schedules WHERE id = $1",
        [schedule.id],
      );
      expect(row.rows[0]).toMatchObject({
        is_enabled: false,
        next_run_at: null,
      });
      const events = await owner.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM domain_event_outbox
          WHERE tenant_id = $1 AND destination = 'notification'
            AND event ->> 'name' = 'report_schedule.paused'
            AND aggregate_id = $2::uuid`,
        [a.tenantId, schedule.id],
      );
      expect(events.rows).toHaveLength(1);
      const deliver = createNotificationConsumer(
        ctx,
        createNotificationRecipientResolver({ email: false, push: false }),
      );
      const { event } = events.rows[0]!;
      await withTenant(db, ctx, (tx) =>
        deliver(event as never, String(event.idempotencyKey), tx as never),
      );
      const notes = await owner.query<{ user_id: string; title: string }>(
        `SELECT user_id::text, title FROM notifications
          WHERE tenant_id = $1 AND category = 'report_delivery'
            AND title LIKE 'Jadwal laporan dijeda%'`,
        [a.tenantId],
      );
      const users = notes.rows.map((n) => n.user_id);
      expect(users).toContain(a.full.userId);
      expect(users).not.toContain(a.peer.userId);
    } finally {
      await owner.query('UPDATE "user" SET banned = false WHERE id = $1', [
        a.peer.userId,
      ]);
      await owner.query(
        "UPDATE roles SET permissions = permissions - 'org.settings.manage' WHERE id = $1",
        [a.roles.full],
      );
    }
  });

  it("does not repeat a slot when job creation fails (at most once)", async () => {
    const schedule = await scheduleFor(a.full, [a.full.userId]);
    await makeDue(schedule.id);
    const before = await owner.query<{ last_run_at: Date | null }>(
      "SELECT last_run_at FROM report_schedules WHERE id = $1",
      [schedule.id],
    );
    expect(before.rows[0]?.last_run_at).toBeNull();
    await runDueReportSchedules(tenantContext(a.tenantId));
    const after = await owner.query<{
      last_run_at: Date | null;
      next_run_at: Date;
    }>("SELECT last_run_at, next_run_at FROM report_schedules WHERE id = $1", [
      schedule.id,
    ]);
    expect(after.rows[0]?.last_run_at).not.toBeNull();
    expect(after.rows[0]?.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("never runs another tenant's schedule", async () => {
    const schedule = await scheduleFor(b.full, [b.full.userId]);
    await makeDue(schedule.id);
    await runDueReportSchedules(tenantContext(a.tenantId));
    expect(await jobsOf(schedule.id)).toHaveLength(0);
  });
});
