import { afterEach, describe, expect, it, vi } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import * as alerts from "../services/edge-sync-conflict-alert.ts";
import * as queue from "../services/edge-queue.service.ts";
import * as scope from "../edge/deferred-event-applier.ts";
import * as runtime from "../edge/print/runtime.ts";
import * as printAgent from "../edge/print/agent.ts";
import { applyPrintAlertRaised } from "../edge/print/alert-applier.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";

vi.mock("../db/tenant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/tenant.ts")>()),
  withTenant: vi.fn(async (_db, _context, callback) => callback({})),
}));

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const context = edgeNodeContext({ tenantId, outletId });
const edgeNodeId = "00000000-0000-4000-8000-0000000002a1";
const initial = getEdgeRuntimeState();

afterEach(() => {
  vi.restoreAllMocks();
  setEdgeRuntimeStateForTests(initial);
});

describe("print supervisor alert wiring", () => {
  it("installs the notifier on startup and clears it on shutdown", async () => {
    const spy = vi.spyOn(printAgent, "setPrintAlertNotifier");
    setEdgeRuntimeStateForTests({
      ...initial,
      edgeMode: true,
      identity: { context, scope: { tenantId, outletId, edgeNodeId } },
    });
    const handle = runtime.startEdgePrintAgent();
    try {
      expect(spy).toHaveBeenCalledWith(expect.any(Function));
    } finally {
      await handle.stop();
    }
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it.each(["printer_offline", "job_failed"] as const)(
    "queues %s on the edge and delivers it to cloud supervisors without private detail",
    async (kind) => {
      const enqueue = vi
        .spyOn(queue, "enqueueEdgeEvent")
        .mockResolvedValue({ linkSeq: 1, duplicate: false });
      const notify = vi
        .spyOn(alerts, "notifyOutletSupervisors")
        .mockResolvedValue(true);
      vi.spyOn(scope, "assertEdgeEventScope").mockResolvedValue(outletId);
      const occurredAt = new Date("2026-11-14T00:00:00Z");
      await runtime.createPrintAlertNotifier(
        context,
        outletId,
        edgeNodeId,
      )({
        kind,
        subjectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        stationId: null,
        detail: { customer: "private data" },
        occurredAt,
      });
      expect(enqueue).toHaveBeenCalledOnce();
      const [tx, receivedContext, queued] = enqueue.mock.calls[0];
      expect(receivedContext).toBe(context);
      expect(queued).toMatchObject({
        edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: {
          tenantId,
          outletId,
          name: "print_alert.raised",
          aggregateType: "print_alert",
          sequence: 1,
          payload: { kind, subjectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        },
      });
      expect(JSON.stringify(queued)).not.toContain("private data");
      expect(notify).not.toHaveBeenCalled();
      const event = eventEnvelopeSchema.parse(queued.event);
      await applyPrintAlertRaised(tx, event, {
        edgeNodeId,
        context,
        direction: "edge_to_cloud",
        kind: "transaction_event",
      });
      expect(notify).toHaveBeenCalledOnce();
      const [, targetContext, alert, now] = notify.mock.calls[0];
      expect(targetContext).toBe(context);
      expect(alert).toMatchObject({
        tenantId,
        outletId,
        category: "printer_offline",
        id: event.id,
        payload: event.payload,
      });
      expect(now).toEqual(occurredAt);
      notify.mockClear();
      await expect(
        applyPrintAlertRaised(
          tx,
          { ...event, version: 2 },
          {
            edgeNodeId,
            context,
            direction: "edge_to_cloud",
            kind: "transaction_event",
          },
        ),
      ).rejects.toThrow();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("does not queue recovery or successful fallback alerts as failures", async () => {
    const enqueue = vi
      .spyOn(queue, "enqueueEdgeEvent")
      .mockResolvedValue({ linkSeq: 1, duplicate: false });
    const notify = runtime.createPrintAlertNotifier(
      context,
      outletId,
      edgeNodeId,
    );
    for (const kind of [
      "printer_online",
      "kds_up",
      "fallback_printed",
    ] as const) {
      await notify({
        kind,
        subjectId: "station",
        stationId: null,
        detail: {},
        occurredAt: new Date(),
      });
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
});
