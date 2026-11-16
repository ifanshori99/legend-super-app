// legend-2lp.2: receipt delivery must hand actual ESC/POS bytes to the edge
// Print Agent. The order/document ports are fixtures; the delivery service and
// receipt renderer remain real. No socket or physical printer is needed.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  cafeLegendPosFixtures,
  posReceiptSchema,
  receiptDocumentSchema,
} from "@starter/shared/pos";
import type { NewPrintJob } from "../edge/print/types.ts";

const ports = vi.hoisted(() => ({
  withTenant: vi.fn(),
  lockOrder: vi.fn(),
  findReceipt: vi.fn(),
  markReprinted: vi.fn(),
  buildDocument: vi.fn(),
  getAgent: vi.fn(),
  runtime: vi.fn(),
  printers: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../db/index.ts", () => ({ db: {} }));
vi.mock("../db/tenant.ts", () => ({ withTenant: ports.withTenant }));
vi.mock("../services/pos-order-support.ts", () => ({
  lockPosOrder: ports.lockOrder,
  notFound: () => new Error("Order not found"),
}));
vi.mock("../services/pos-receipt.service.ts", () => ({
  findReceiptById: ports.findReceipt,
  findReceiptByNumber: ports.findReceipt,
  findReceiptForOrder: ports.findReceipt,
  markReceiptReprinted: ports.markReprinted,
}));
vi.mock("../services/pos-receipt-document.ts", () => ({
  buildReceiptDocument: ports.buildDocument,
  buildInvoiceDocument: vi.fn(),
}));
vi.mock("../edge/runtime.ts", () => ({
  getEdgeRuntimeState: ports.runtime,
}));
vi.mock("../edge/print/runtime.ts", () => ({
  getEdgePrintAgent: ports.getAgent,
}));
vi.mock("../edge/print/store.ts", () => ({
  createDbPrintStore: () => ({ listPrinters: ports.printers }),
}));

import { edgePrinters } from "../db/schema/edge-print.ts";
import {
  posReceiptDeliveries,
  posReceiptLinks,
} from "../db/schema/pos-receipt.ts";
import { issueReceiptDeliveries } from "../services/pos-receipt-delivery.service.ts";

const receipt = posReceiptSchema.parse(cafeLegendPosFixtures.receipts[0]);
const document = receiptDocumentSchema.parse({
  ...cafeLegendPosFixtures.receiptDocuments[0],
  id: receipt.id,
});
const context: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: receipt.tenantId,
    brandId: null,
    source: "session",
  }),
  { kind: "outlets", outletIds: [receipt.outletId] },
);
const caller = {
  userId: userIdSchema.parse("00000000-0000-4000-8000-000000000928"),
};
const printer = {
  id: "00000000-0000-4000-8000-000000000929",
  tenantId: receipt.tenantId,
  outletId: receipt.outletId,
  label: "Kasir",
  role: "receipt",
  paperWidth: 48,
  retiredAt: null,
};

type DeliveryRow = typeof posReceiptDeliveries.$inferSelect;
let deliveries: DeliveryRow[];
let queued: NewPrintJob[];

/** Only the delivery table is mutable; transaction errors restore it. */
function transaction() {
  return {
    select: () => ({
      from: (table: unknown) => {
        const result = () =>
          table === posReceiptLinks
            ? []
            : table === edgePrinters
              ? ports.printers()
              : deliveries;
        const query = {
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(result()).then(resolve),
        };
        return query;
      },
    }),
    insert: () => ({
      values: (
        values: Omit<
          DeliveryRow,
          "id" | "createdAt" | "updatedAt" | "failureReason" | "attempts"
        >,
      ) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (
              deliveries.some(
                (row) =>
                  row.channel === values.channel &&
                  row.idempotencyKey === values.idempotencyKey,
              )
            )
              return [];
            const id = randomUUID();
            deliveries.push({
              ...values,
              id,
              createdAt: new Date(),
              updatedAt: new Date(),
              failureReason: null,
              attempts: 0,
            });
            return [{ id }];
          },
        }),
      }),
    }),
  };
}

function issue(idempotencyKey = "receipt-928-first") {
  return issueReceiptDeliveries(
    context,
    caller,
    receipt.outletId,
    receipt.orderId,
    { deliveries: ["print"], idempotencyKey },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deliveries = [];
  queued = [];
  ports.withTenant.mockImplementation(
    async (_db: unknown, _context: unknown, run: (tx: unknown) => unknown) => {
      const before = [...deliveries];
      try {
        return await run(transaction());
      } catch (error) {
        deliveries = before;
        throw error;
      }
    },
  );
  ports.lockOrder.mockResolvedValue({ order: { status: "completed" } });
  ports.findReceipt.mockResolvedValue({ ...receipt });
  ports.markReprinted.mockResolvedValue({ ...receipt, reprintCount: 1 });
  ports.buildDocument.mockImplementation(
    async (
      _tx: unknown,
      _context: unknown,
      current: { reprintCount: number },
    ) => ({
      ...document,
      reprint: current.reprintCount > 0,
    }),
  );
  ports.printers.mockResolvedValue([printer]);
  ports.runtime.mockReturnValue({
    edgeMode: true,
    identity: {
      context,
      scope: {
        tenantId: receipt.tenantId,
        outletId: receipt.outletId,
        edgeNodeId: "00000000-0000-4000-8000-000000000930",
      },
    },
  });
  ports.enqueue.mockImplementation(async (job: NewPrintJob) => {
    if (!queued.some((row) => row.idempotencyKey === job.idempotencyKey))
      queued.push(job);
    return { id: createUlid(), ...job, status: "queued" };
  });
  ports.getAgent.mockReturnValue({ enqueue: ports.enqueue });
});

describe("legend-2lp.2 POS receipt through edge Print Agent", () => {
  it("queues real receipt ESC/POS bytes on the outlet receipt printer", async () => {
    const result = await issue();
    expect(result.document.receiptNumber).toBe(receipt.number);
    expect(queued).toHaveLength(1);
    const job = queued[0]!;
    expect(job).toMatchObject({
      printerId: printer.id,
      kind: "receipt",
      createdBy: caller.userId,
      sourceRef: receipt.number,
    });
    const bytes = Buffer.from(job.content);
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    const text = bytes.toString("latin1");
    expect(text).toContain(document.outletName);
    expect(text.replace(/\s+/g, " ")).toContain(document.outletAddress);
    expect(text).toContain(receipt.number);
    expect(text).toContain(document.items[0]!.name);
    expect(text).not.toContain("CETAK ULANG");
  });

  it("replays one print request once; a new request marks the output as a reprint", async () => {
    await issue("receipt-928-one");
    await issue("receipt-928-one");
    expect(queued).toHaveLength(1);
    expect(ports.markReprinted).not.toHaveBeenCalled();
    await issue("receipt-928-two");
    expect(queued).toHaveLength(2);
    expect(queued[0]!.idempotencyKey).not.toBe(queued[1]!.idempotencyKey);
    expect(Buffer.from(queued[1]!.content).toString("latin1")).toContain(
      "CETAK ULANG",
    );
  });

  it("prints the stored rounding adjustment alongside the total", async () => {
    await issue();
    const text = Buffer.from(queued[0]!.content).toString("latin1");
    expect(document.roundingIdr).toBe(-20);
    expect(text).toMatch(/Pembulatan\s+-Rp 20/);
    expect(text).toContain("Rp 120.100");
  });

  it("clearly marks a voided receipt so it cannot look like a valid sale", async () => {
    ports.buildDocument.mockResolvedValue({ ...document, status: "voided" });
    await issue();
    expect(Buffer.from(queued[0]!.content).toString("latin1")).toContain(
      "DIBATALKAN",
    );
  });

  it("does not report a successful edge print when the receipt printer is absent", async () => {
    ports.printers.mockResolvedValue([]);
    await expect(issue()).rejects.toThrow();
    expect(ports.enqueue).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it("rejects an unavailable edge agent instead of recording a sent delivery", async () => {
    ports.getAgent.mockReturnValue(null);
    await expect(issue()).rejects.toThrow("Agen cetak outlet belum siap");
    expect(ports.enqueue).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it("never queues a receipt on an edge identity for another outlet", async () => {
    ports.runtime.mockReturnValue({
      edgeMode: true,
      identity: {
        context,
        scope: {
          tenantId: receipt.tenantId,
          outletId: "00000000-0000-4000-8000-000000000999",
          edgeNodeId: "00000000-0000-4000-8000-000000000930",
        },
      },
    });
    await expect(issue()).rejects.toThrow("edge node outlet asal");
    expect(ports.enqueue).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it("does not record a sent delivery when the edge queue rejects the job", async () => {
    ports.enqueue.mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(issue()).rejects.toThrow("Queue unavailable");
    expect(ports.enqueue).toHaveBeenCalledOnce();
    expect(deliveries).toHaveLength(0);
  });

  it("keeps cloud document delivery usable without a local Print Agent", async () => {
    ports.runtime.mockReturnValue({ edgeMode: false, identity: null });
    ports.getAgent.mockReturnValue(null);
    const result = await issue();
    expect(result.document.receiptNumber).toBe(receipt.number);
    expect(ports.enqueue).not.toHaveBeenCalled();
  });
});
