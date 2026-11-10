// pullDeviceRegistry carries the receipt run refusal report (bead
// legend-hfq3z): the clash refusals of one pulled page are sent with the NEXT
// page request (`fetchPage(since, receiptRuns, refusals)`), and the last
// report is returned as `receiptRunRefusals` so the edge runtime can send it
// on its next pull. The cloud side (rotating the refused run) is covered in
// pos-receipt-seq-edge.test.ts; this file only fakes `fetchPage`.
//
// Real PostgreSQL with RLS (the pull applies pages to a database). As in
// pos-receipt-seq-edge.test.ts the edge database is simulated by its own
// outlet in the test database; sequence setup helpers are copied, not shared.
//
// Assumptions (Design, brief points 1 and 2):
//  - A pulled run bound to this edge whose PREFIX already belongs to another
//    local run is refused as `prefix_used`; the report maps the refused run's
//    id (the id of the pulled run, not of a local row) to that reason.
//  - A replacement the cloud already advanced (lastNumber > 0) is refused but
//    NOT reported (a new prefix would not fix it).
//  - The `id_used` reason has no cheap setup here (it needs a run whose id
//    already exists locally under other values); its mapping is covered at
//    cloud level in pos-receipt-seq-edge.test.ts.
//  - A page counts as "applied" when it carries `receiptSequences` and the
//    role is primary with a binding; any other page clears the report.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  deviceSyncPageSchema,
  type DeviceReceiptSequenceBinding,
  type DeviceReceiptSequenceSync,
  type ReceiptRunRefusalReason,
  type ReceiptRunRefusalReport,
} from "@starter/shared/edge";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { pullDeviceRegistry } from "../services/edge-device-sync.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Binding = DeviceReceiptSequenceBinding;

let tenant: IsolatedTenant;
const cloudState = getEdgeRuntimeState();

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

const edgeScope = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Uji', 'Jl. Uji 1', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `R${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

/** This edge database's own `edge_nodes` row (id = node, instance_id = instance). */
async function localEdgeNode(outletId: string, own: Binding): Promise<void> {
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, $5)
       ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [
        own.edgeNodeId,
        tenant.tenantId,
        outletId,
        "b".repeat(64),
        own.edgeInstanceId,
      ],
    ),
  );
}

async function inEdgeMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
}

function seq(
  outletId: string,
  deviceId: string,
  prefix: string,
  binding: Binding,
  lastNumber = 0,
): DeviceReceiptSequenceSync {
  return {
    id: randomUUID(),
    outletId: outletIdSchema.parse(outletId),
    deviceId,
    prefix,
    lastNumber,
    ...binding,
  };
}

type PageSpec = {
  /** Omitted = the page carries no `receiptSequences` key (a cloud without them). */
  sequences?: DeviceReceiptSequenceSync[];
};

/** Pages chained by cursors c1, c2, ...; the last page ends the pull. */
function pagesOf(specs: PageSpec[]): unknown[] {
  return specs.map((spec, index) =>
    deviceSyncPageSchema.parse({
      data: [],
      ...(spec.sequences ? { receiptSequences: spec.sequences } : {}),
      meta: {
        limit: 100,
        nextCursor: index === specs.length - 1 ? null : `c${index + 1}`,
        watermark: null,
      },
    }),
  );
}

type Call = {
  since: string | null;
  refusals: ReceiptRunRefusalReport | undefined;
};

/** One pull of `pages` through the real pullDeviceRegistry, recording each request. */
async function pull(
  outletId: string,
  own: Binding,
  pages: unknown[],
  options: {
    role?: "primary" | "standby";
    refusals?: ReceiptRunRefusalReport;
  } = {},
) {
  await localEdgeNode(outletId, own);
  const calls: Call[] = [];
  const result = await inEdgeMode(() =>
    pullDeviceRegistry({
      context: edgeScope(outletId),
      role: options.role ?? "primary",
      binding: own,
      ...(options.refusals ? { refusals: options.refusals } : {}),
      fetchPage: async (
        since: string | null,
        _receiptRuns?: unknown,
        refusals?: ReceiptRunRefusalReport,
      ) => {
        calls.push({
          since,
          refusals: refusals ? new Map(refusals) : undefined,
        });
        const page = pages[calls.length - 1];
        if (page === undefined)
          throw new Error("Unexpected extra page request");
        return page;
      },
    }),
  );
  return { result, calls };
}

/**
 * An edge holding device A on P1 and device B on P2, both bound to `own`.
 * `b2` is the run the cloud keeps listing for B.
 */
async function seededEdge() {
  const outletId = await freshOutlet();
  const own: Binding = {
    edgeNodeId: randomUUID(),
    edgeInstanceId: randomUUID(),
  };
  const [deviceA, deviceB] = [randomUUID(), randomUUID()];
  const a1 = seq(outletId, deviceA, "P1", own);
  const b2 = seq(outletId, deviceB, "P2", own);
  await pull(outletId, own, pagesOf([{ sequences: [a1, b2] }]));
  return { outletId, own, deviceA, deviceB, a1, b2 };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`rfs-${randomUUID().slice(0, 6)}`);
});

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  await owner.end();
});

describe("legend-hfq3z pullDeviceRegistry reports the refusals of a pull", () => {
  it("POS-06 EDG-02 a replacement whose prefix is already used locally is refused and returned as prefix_used under the refused run's id", async () => {
    const { outletId, own, deviceA, b2 } = await seededEdge();
    const clash = seq(outletId, deviceA, "P2", own);

    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [clash, b2] }]),
    );

    expect(result.receiptSequencesRefused).toBe(1);
    expect(result.receiptRunRefusals).toEqual(
      new Map<string, ReceiptRunRefusalReason>([[clash.id, "prefix_used"]]),
    );
    // Nothing to report on the request that produced the refusal.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.refusals).toBeUndefined();
  });

  it("POS-06 a normal pull (same runs again) reports nothing and sends nothing", async () => {
    const { outletId, own, a1, b2 } = await seededEdge();
    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [a1, b2] }]),
    );
    expect(result.receiptSequencesRefused).toBe(0);
    expect(result.receiptRunRefusals.size).toBe(0);
    expect(calls[0]!.refusals).toBeUndefined();
  });

  it("POS-06 EDG-02 the refusals of page 1 are sent with the request for page 2, and page 2 (accepted) clears the report", async () => {
    const { outletId, own, deviceA, b2 } = await seededEdge();
    const clash = seq(outletId, deviceA, "P2", own);

    const { result, calls } = await pull(
      outletId,
      own,
      // Page 2 lists only B's unchanged run: nothing on it can be refused.
      pagesOf([{ sequences: [clash, b2] }, { sequences: [b2] }]),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.since).toBeNull();
    expect(calls[0]!.refusals).toBeUndefined();
    expect(calls[1]!.since).toBe("c1");
    expect(calls[1]!.refusals).toEqual(
      new Map<string, ReceiptRunRefusalReason>([[clash.id, "prefix_used"]]),
    );
    // The last page applied without a refusal: nothing is left to report.
    expect(result.receiptRunRefusals.size).toBe(0);
  });

  it("POS-06 the report is replaced page by page, not accumulated: the result holds only the last page's refusals", async () => {
    const { outletId, own, deviceA, b2 } = await seededEdge();
    const first = seq(outletId, deviceA, "P2", own);
    const second = seq(outletId, deviceA, "P2", own);

    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [first, b2] }, { sequences: [second, b2] }]),
    );

    expect(calls[1]!.refusals).toEqual(
      new Map<string, ReceiptRunRefusalReason>([[first.id, "prefix_used"]]),
    );
    expect(result.receiptRunRefusals).toEqual(
      new Map<string, ReceiptRunRefusalReason>([[second.id, "prefix_used"]]),
    );
    expect(result.receiptRunRefusals.has(first.id)).toBe(false);
  });

  it("POS-06 a page without receiptSequences clears the report: the request after it carries nothing", async () => {
    const { outletId, own, deviceA, b2 } = await seededEdge();
    const clash = seq(outletId, deviceA, "P2", own);

    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([
        { sequences: [clash, b2] },
        {}, // a cloud that sends no sequences cannot use the report
        {},
      ]),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]!.refusals?.size).toBe(1);
    expect(calls[2]!.refusals).toBeUndefined();
    expect(result.receiptRunRefusals.size).toBe(0);
  });
});

describe("legend-hfq3z the report of the previous pull (options.refusals)", () => {
  it("POS-06 EDG-02 options.refusals go out on the first page request and stay out of later ones once that page was applied", async () => {
    const { outletId, own, a1, b2 } = await seededEdge();
    const previous = new Map<string, ReceiptRunRefusalReason>([
      [randomUUID(), "prefix_used"],
      [randomUUID(), "id_used"],
    ]);

    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [a1, b2] }, { sequences: [a1, b2] }]),
      { refusals: previous },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.refusals).toEqual(previous);
    expect(calls[1]!.refusals).toBeUndefined();
    expect(result.receiptRunRefusals.size).toBe(0);
  });

  it("POS-06 a first page without receiptSequences still receives options.refusals, then the report is cleared", async () => {
    const { outletId, own } = await seededEdge();
    const previous = new Map<string, ReceiptRunRefusalReason>([
      [randomUUID(), "prefix_used"],
    ]);

    const { result, calls } = await pull(outletId, own, pagesOf([{}]), {
      refusals: previous,
    });

    expect(calls[0]!.refusals).toEqual(previous);
    expect(result.receiptRunRefusals.size).toBe(0);
  });

  it("POS-06 an empty options.refusals sends nothing (the parameter is omitted, not empty)", async () => {
    const { outletId, own, a1, b2 } = await seededEdge();
    const { calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [a1, b2] }]),
      { refusals: new Map() },
    );
    expect(calls[0]!.refusals).toBeUndefined();
  });

  it("POS-06 a standby never reports refusals and returns an empty report", async () => {
    const { outletId, own, a1, b2 } = await seededEdge();
    const { result, calls } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [a1, b2] }]),
      {
        role: "standby",
        refusals: new Map<string, ReceiptRunRefusalReason>([
          [randomUUID(), "prefix_used"],
        ]),
      },
    );
    expect(calls[0]!.refusals).toBeUndefined();
    expect(result.receiptRunRefusals.size).toBe(0);
  });
});

describe("legend-hfq3z refusals that a new run would not fix are not reported", () => {
  it("POS-06 EDG-02 a replacement the cloud already advanced (lastNumber > 0) is refused and counted, but not in the report", async () => {
    const outletId = await freshOutlet();
    const own: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    const deviceId = randomUUID();
    await pull(
      outletId,
      own,
      pagesOf([{ sequences: [seq(outletId, deviceId, "P1", own)] }]),
    );

    const { result } = await pull(
      outletId,
      own,
      pagesOf([{ sequences: [seq(outletId, deviceId, "P2", own, 3)] }]),
    );

    expect(result.receiptSequencesRefused).toBe(1);
    expect(result.receiptRunRefusals.size).toBe(0);
  });
});
