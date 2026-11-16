// legend-2lp.5 / EDG-05: a stopped KDS needs the same supervisor delivery
// path as a stopped printer. Private ticket detail must stay on the edge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cafeLegendFixtures, createUlid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { applyPrintAlertRaised } from "../edge/print/alert-applier.ts";
import { createPrintAlertNotifier } from "../edge/print/runtime.ts";
import * as coreAudit from "../services/core-audit.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import * as queue from "../services/edge-queue.service.ts";
import * as alerts from "../services/edge-sync-conflict-alert.ts";
import * as scope from "../edge/deferred-event-applier.ts";

vi.mock("../db/tenant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/tenant.ts")>()),
  withTenant: vi.fn(async (_db, _context, callback) => callback({})),
}));

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const context = edgeNodeContext({ tenantId, outletId });
const edgeNodeId = "00000000-0000-4000-8000-000000000928";
const stationId = "00000000-0000-4000-8000-000000000929";
const occurredAt = new Date("2026-11-16T10:00:00Z");

afterEach(() => vi.restoreAllMocks());

describe("legend-2lp.5 KDS-down supervisor delivery", () => {
  it("queues KDS-down with a stable event identity and no private ticket detail", async () => {
    const enqueue = vi
      .spyOn(queue, "enqueueEdgeEvent")
      .mockResolvedValue({ linkSeq: 1, duplicate: false });
    const notify = createPrintAlertNotifier(context, outletId, edgeNodeId);
    const alert = {
      id: createUlid(),
      kind: "kds_down" as const,
      subjectId: stationId,
      stationId,
      detail: { customer: "PRIVATE CUSTOMER", order: "PRIVATE ORDER" },
      occurredAt,
    };
    await notify(alert);
    await notify({ ...alert });

    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [, queuedContext, queued] of enqueue.mock.calls) {
      expect(queuedContext).toBe(context);
      expect(queued).toMatchObject({
        edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: {
          id: alert.id,
          aggregateId: alert.id,
          name: "print_alert.raised",
          tenantId,
          outletId,
          occurredAt: occurredAt.toISOString(),
          payload: { kind: "kds_down", subjectId: stationId },
        },
      });
      expect(JSON.stringify(queued)).not.toContain("PRIVATE");
    }
  });

  it("delivers a valid KDS-down event to the originating outlet supervisors", async () => {
    vi.spyOn(scope, "assertEdgeEventScope").mockResolvedValue(outletId);
    const notify = vi
      .spyOn(alerts, "notifyOutletSupervisors")
      .mockResolvedValue(true);
    const id = createUlid();
    const event = eventEnvelopeSchema.parse({
      id,
      tenantId,
      outletId,
      name: "print_alert.raised",
      version: 1,
      aggregateType: "print_alert",
      aggregateId: id,
      sequence: 1,
      occurredAt: occurredAt.toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `print_alert:${id}`,
      payloadSchemaRef: "print_alert.raised.v1",
      payload: { kind: "kds_down", subjectId: stationId },
    });

    await withTenant(db, context, (tx) =>
      applyPrintAlertRaised(tx, event, {
        edgeNodeId,
        context,
        direction: "edge_to_cloud",
        kind: "transaction_event",
      }),
    );

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        id,
        tenantId,
        outletId,
        category: "printer_offline",
        title: expect.stringMatching(/KDS|layar/i),
        payload: { kind: "kds_down", subjectId: stationId },
      }),
      occurredAt,
    );
  });
});

describe("legend-2lp.5 print audit snapshots", () => {
  it.each([
    {
      action: "print_job.reprinted",
      safe: {
        originalJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "receipt",
        printerId: stationId,
      },
    },
    {
      action: "print_job.retried",
      safe: { status: "queued", kind: "receipt", printerId: stationId },
    },
  ])(
    "keeps useful $action fields while masking receipt content",
    async ({ action, safe }) => {
      const append = vi.spyOn(coreAudit, "recordAudit").mockResolvedValue();
      await withTenant(db, context, (tx) =>
        coreAuditWriter.record(
          {
            tenantId,
            outletId,
            actorType: "system",
            actorId: null,
            deviceId: null,
            action,
            objectType: "print_job",
            objectId: createUlid(),
            reason: null,
            before: null,
            after: {
              ...safe,
              content: "PRIVATE RECEIPT",
              customerName: "PRIVATE NAME",
            },
            sensitiveAccess: false,
          },
          { tx, context },
        ),
      );

      expect(append).toHaveBeenCalledOnce();
      const [, auditContext, event] = append.mock.calls[0]!;
      expect(auditContext).toBe(context);
      expect(event).toHaveProperty("maskedChanges.after", {
        ...safe,
        content: "[REDACTED]",
        customerName: "[REDACTED]",
      });
      expect(JSON.stringify(event)).not.toContain("PRIVATE");
    },
  );
});
