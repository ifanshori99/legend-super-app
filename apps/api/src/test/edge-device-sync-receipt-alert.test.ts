// Receipt-run alert persisted by the device-registry pull (legend-m8vf0, slice S4
// of docs/design/edge-status-cloud.md; tests T22-T25 of section 6, rule D6).
// Written from the design and the existing receipt-run tests, not from the
// implementation.
//
// Spec (D6): the cloud already computes `receiptRunAlert` while answering a
// device-registry pull of the active PRIMARY edge node that sent `edgeInstance`
// and a decoded `receiptRuns` report. In the same pull transaction, inside a
// savepoint:
//  - alert true                               -> open one `receipt_run_alert`
//                                                for that node (`edge_node_alerts`);
//  - alert false AND the report was really processed (claim.stale === 0)
//                                             -> resolve the node's open alert,
//                                                but only when it was last seen
//                                                more than 24 h ago;
//  - any other pull (stale report, no `receiptRuns`, a standby) changes nothing.
// A failure inside the savepoint never refuses the page and never rolls back the
// receipt claim.
//
// Same simulation as pos-receipt-restore-detect.test.ts (helpers copied, not
// edited): the cloud answers `listDeviceRecordsSince` for one outlet; the node
// is a row in `edge_nodes`. No edge database is needed: only cloud pulls.
//
// Assumptions:
//  - A regression-driven alert is produced the same way as in
//    pos-receipt-restore-detect.test.ts ("clone": two rotations of one device).
//    The cloud keeps that alert true for 24 h, and a retired row cannot be
//    back-dated, so "clean pull after 24 h quiet" is tested with an open alert
//    row SEEDED by owner SQL on a node whose own report is clean (alert false).
//  - The 24 h rule is measured on `last_seen_at`: a seeded row last seen 12 h ago
//    stays open after a clean pull; one last seen 48 h ago is resolved. (The
//    exact clock, cloud arrival time or wall clock, does not matter at that margin.)
//  - A standby node pulling with `edgeInstance` and `receiptRuns` is answered
//    (the page is served) and never claims; the claim is the only writer.
//  - A savepoint failure is forced with a test-only trigger on
//    `edge_node_alerts`, scoped to one node id, dropped in `finally`.
//  - Alert rows are read with owner SQL (columns of D5); no API for them is used.
//  - `edge_node_alerts` and the alert writes do not exist yet: every test fails
//    on the missing table or the missing row, never on setup.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  encodeReceiptRunReport,
  type DeviceReceiptSequenceBinding,
  type DeviceSyncPage,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
} from "../services/edge-device-sync.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

type Binding = DeviceReceiptSequenceBinding;

let tenant: IsolatedTenant;
const actor = randomUUID();
const HOUR_MS = 3_600_000;

// ---- Database helpers --------------------------------------------------------

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

const cloudScope = (outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** An outlet of the isolated tenant with no receipt run yet. */
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
      `Q${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

async function enrollPos(outletId: string): Promise<string> {
  const { device } = await enrollDevice(cloudScope(outletId), actor, {
    outletId,
    type: "pos",
    label: `Perangkat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device.id;
}

async function insertNode(
  outletId: string,
  role: "primary" | "standby",
): Promise<Binding> {
  const id = randomUUID();
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, $4, 'active', 'Server lokal', $5)`,
      [id, tenant.tenantId, outletId, role, "a".repeat(64)],
    ),
  );
  return { edgeNodeId: id, edgeInstanceId: randomUUID() };
}

/** A cloud outlet with one pos device and an active primary node, nothing pulled. */
async function cloudOutlet() {
  const outletId = await freshOutlet();
  await enrollPos(outletId);
  const own = await insertNode(outletId, "primary");
  return { outletId, own };
}

type AlertRow = {
  id: string;
  tenant_id: string;
  outlet_id: string;
  edge_node_id: string;
  kind: string;
  raised_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
};

function alertRows(edgeNodeId: string): Promise<AlertRow[]> {
  return asOwnerTenant(async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, outlet_id, edge_node_id, kind, raised_at, last_seen_at, resolved_at
       FROM edge_node_alerts
       WHERE tenant_id = $1 AND edge_node_id = $2
       ORDER BY raised_at, id`,
      [tenant.tenantId, edgeNodeId],
    );
    return result.rows as AlertRow[];
  });
}

const openRows = (rows: AlertRow[]) =>
  rows.filter((r) => r.resolved_at === null);

/** An open `receipt_run_alert` last seen `ageHours` ago (owner SQL, D5 columns). */
async function seedOpenAlert(
  outletId: string,
  edgeNodeId: string,
  ageHours: number,
): Promise<AlertRow> {
  const lastSeen = new Date(Date.now() - ageHours * HOUR_MS);
  const raised = new Date(lastSeen.getTime() - HOUR_MS);
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edge_node_alerts
         (id, tenant_id, outlet_id, edge_node_id, kind, raised_at, last_seen_at, resolved_at, detail)
       VALUES ($1, $2, $3, $4, 'receipt_run_alert', $5, $6, NULL, '{}'::jsonb)`,
      [randomUUID(), tenant.tenantId, outletId, edgeNodeId, raised, lastSeen],
    ),
  );
  const [row] = await alertRows(edgeNodeId);
  if (!row) throw new Error("seeded alert row not found");
  return row;
}

type SeqRow = {
  prefix: string;
  retired_reason: string | null;
  edge_reported_number: number;
  retired_at: Date | null;
};

function sequenceRows(outletId: string): Promise<SeqRow[]> {
  return asOwnerTenant(async (client) => {
    const result = await client.query(
      `SELECT prefix, retired_reason, edge_reported_number, retired_at
       FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
      [tenant.tenantId, outletId],
    );
    return result.rows as SeqRow[];
  });
}

const seqOf = (rows: SeqRow[], prefix: string): SeqRow => {
  const row = rows.find((r) => r.prefix === prefix);
  if (!row) throw new Error(`No sequence ${prefix} in ${JSON.stringify(rows)}`);
  return row;
};

// ---- Cloud pull helpers (copied from pos-receipt-restore-detect.test.ts) -----

let lastCloudNow = 0;
/** Strictly increasing cloud arrival time, 10 min ahead of the real clock. */
function nextCloudNow(): Date {
  lastCloudNow = Math.max(Date.now() + 10 * 60_000, lastCloudNow + 1);
  return new Date(lastCloudNow);
}

/** `at(10)` = 10 s after a base 10 min ahead of the real clock. */
function clock(): (seconds: number) => Date {
  const base = Date.now() + 10 * 60_000;
  return (seconds) => new Date(base + seconds * 1000);
}

/** The cloud answering one device-records pull of node N, instance I. */
function cloudPull(
  outletId: string,
  own: Binding,
  options: { report?: ReceiptRunReport; now?: Date } = {},
): Promise<DeviceSyncPage> {
  const query = deviceSyncQuerySchema.parse({
    limit: 100,
    receiptSequences: "1",
    edgeInstance: own.edgeInstanceId,
    ...(options.report
      ? { receiptRuns: encodeReceiptRunReport(options.report) }
      : {}),
  });
  return listDeviceRecordsSince(
    {
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      outletId: outletIdSchema.parse(outletId),
      edgeNodeId: own.edgeNodeId,
    },
    query,
    { now: options.now ?? nextCloudNow(), settleMs: 0 },
  );
}

const prefixes = (page: DeviceSyncPage) =>
  page.receiptSequences?.map((s) => s.prefix);

/**
 * Drives one device of a cloned database to the rotation limit (2 regression
 * rotations in 24 h): the second pull returns `receiptRunAlert: true`.
 * Returns the page of the first regression (alert false) and of the second.
 */
async function cloneUntilAlert(outletId: string, own: Binding) {
  await cloudPull(outletId, own, { report: new Map() });
  await cloudPull(outletId, own, { report: new Map([["P1", 3]]) });
  const first = await cloudPull(outletId, own, {
    report: new Map([["P1", 1]]),
  });
  await cloudPull(outletId, own, { report: new Map([["P2", 5]]) });
  const second = await cloudPull(outletId, own, {
    report: new Map([["P2", 2]]),
  });
  return { first, second };
}

// ---- Setup ---------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`rra-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ---- Cases ---------------------------------------------------------------------

describe("T22 a primary pull whose receipt-run alert is true opens one alert for that node", () => {
  it("opens a receipt_run_alert for the node with the alert, none before it", async () => {
    const { outletId, own } = await cloudOutlet();
    const { first, second } = await cloneUntilAlert(outletId, own);

    // The first regression is a single restore: alert false, nothing stored.
    expect("receiptRunAlert" in first).toBe(false);
    // The second rotation raises the alert: the page says so and it is stored.
    expect(second.receiptRunAlert).toBe(true);

    const rows = await alertRows(own.edgeNodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenant.tenantId,
      outlet_id: outletId,
      edge_node_id: own.edgeNodeId,
      kind: "receipt_run_alert",
      resolved_at: null,
    });
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.raised_at.getTime(),
    );
  });

  it("a later alert pull keeps one open row and does not move last_seen_at back", async () => {
    const { outletId, own } = await cloudOutlet();
    await cloneUntilAlert(outletId, own);
    const [before] = await alertRows(own.edgeNodeId);
    expect(before).toBeDefined();

    const again = await cloudPull(outletId, own, {
      report: new Map([["P3", 9]]),
    });
    expect(again.receiptRunAlert).toBe(true);

    const rows = await alertRows(own.edgeNodeId);
    expect(rows).toHaveLength(1);
    expect(openRows(rows)).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.raised_at.getTime()).toBe(before!.raised_at.getTime());
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      before!.last_seen_at.getTime(),
    );
  });

  it("a standby pull never creates an alert, even on an outlet whose primary alerts", async () => {
    const { outletId, own } = await cloudOutlet();
    await cloneUntilAlert(outletId, own);
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(1);

    const standby = await insertNode(outletId, "standby");
    const page = await cloudPull(outletId, standby, {
      report: new Map([["P3", 9]]),
    });
    expect(page).toBeDefined();

    expect(await alertRows(standby.edgeNodeId)).toHaveLength(0);
    // The primary's alert is untouched.
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(1);
  });
});

describe("T23 a clean processed pull resolves the alert only after 24 h without a new alert", () => {
  async function cleanNodeWithOpenAlert(ageHours: number) {
    const { outletId, own } = await cloudOutlet();
    const at = clock();
    // Binds the run P1 at 0 and counts as a processed, alert-free report.
    const bind = await cloudPull(outletId, own, {
      report: new Map(),
      now: at(10),
    });
    expect(prefixes(bind)).toEqual(["P1"]);
    expect(await alertRows(own.edgeNodeId)).toHaveLength(0);
    const seeded = await seedOpenAlert(outletId, own.edgeNodeId, ageHours);
    return { outletId, own, at, seeded };
  }

  it("last seen 12 h ago: a clean processed pull leaves it open", async () => {
    const { outletId, own, at, seeded } = await cleanNodeWithOpenAlert(12);
    const page = await cloudPull(outletId, own, {
      report: new Map([["P1", 1]]),
      now: at(20),
    });
    expect("receiptRunAlert" in page).toBe(false);

    const rows = await alertRows(own.edgeNodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: seeded.id, resolved_at: null });
  });

  it("last seen 48 h ago: a clean processed pull resolves it, never before its raised_at", async () => {
    const { outletId, own, at, seeded } = await cleanNodeWithOpenAlert(48);
    const page = await cloudPull(outletId, own, {
      report: new Map([["P1", 1]]),
      now: at(20),
    });
    expect("receiptRunAlert" in page).toBe(false);

    const rows = await alertRows(own.edgeNodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(seeded.id);
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(rows[0]!.resolved_at!.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.raised_at.getTime(),
    );
    expect(openRows(rows)).toHaveLength(0);
  });
});

describe("T24 a pull that did not process a report changes nothing", () => {
  it("a stale report (token not newer than the stored one) leaves an old open alert alone", async () => {
    const { outletId, own } = await cloudOutlet();
    const at = clock();
    await cloudPull(outletId, own, { report: new Map(), now: at(10) });
    await cloudPull(outletId, own, {
      report: new Map([["P1", 5]]),
      now: at(40),
    });
    const seeded = await seedOpenAlert(outletId, own.edgeNodeId, 48);

    // P1:3 arrives with a token older than the stored one: skipped as stale.
    const stale = await cloudPull(outletId, own, {
      report: new Map([["P1", 3]]),
      now: at(35),
    });
    expect(prefixes(stale)).toEqual(["P1"]);
    expect("receiptRunAlert" in stale).toBe(false);
    const after = await alertRows(own.edgeNodeId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: seeded.id, resolved_at: null });
    expect(after[0]!.last_seen_at.getTime()).toBe(
      seeded.last_seen_at.getTime(),
    );

    // Control: the same alert IS resolved by a processed report, so the
    // assertion above is not vacuous.
    await cloudPull(outletId, own, {
      report: new Map([["P1", 6]]),
      now: at(50),
    });
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(0);
  });

  it("a pull without receiptRuns (old edge) leaves an old open alert alone", async () => {
    const { outletId, own } = await cloudOutlet();
    const at = clock();
    await cloudPull(outletId, own, { report: new Map(), now: at(10) });
    const seeded = await seedOpenAlert(outletId, own.edgeNodeId, 48);

    const old = await cloudPull(outletId, own, { now: at(20) });
    expect(prefixes(old)).toEqual(["P1"]);
    expect("receiptRunAlert" in old).toBe(false);
    const after = await alertRows(own.edgeNodeId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: seeded.id, resolved_at: null });
    expect(after[0]!.last_seen_at.getTime()).toBe(
      seeded.last_seen_at.getTime(),
    );

    // Control: a processed report resolves it.
    await cloudPull(outletId, own, {
      report: new Map([["P1", 1]]),
      now: at(30),
    });
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(0);
  });

  it("a pull without receiptRuns never opens an alert, even when the outlet is in clone state", async () => {
    const { outletId, own } = await cloudOutlet();
    await cloneUntilAlert(outletId, own);
    // Close the alert the clone pull opened, then pull as an old edge.
    await asOwnerTenant((client) =>
      client.query(
        "UPDATE edge_node_alerts SET resolved_at = GREATEST(now(), raised_at) WHERE tenant_id = $1 AND edge_node_id = $2 AND resolved_at IS NULL",
        [tenant.tenantId, own.edgeNodeId],
      ),
    );
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(0);

    const old = await cloudPull(outletId, own);
    expect("receiptRunAlert" in old).toBe(false);
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(0);
  });

  it("a standby pull with a clean report leaves an old open alert alone (only a claim resolves)", async () => {
    const { outletId } = await cloudOutlet();
    const standby = await insertNode(outletId, "standby");
    const seeded = await seedOpenAlert(outletId, standby.edgeNodeId, 48);

    const page = await cloudPull(outletId, standby, { report: new Map() });
    expect(page).toBeDefined();
    const after = await alertRows(standby.edgeNodeId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: seeded.id, resolved_at: null });
    expect(after[0]!.last_seen_at.getTime()).toBe(
      seeded.last_seen_at.getTime(),
    );
  });
});

describe("T25 a failing alert write never refuses the page nor rolls back the claim", () => {
  it("the page is served, the rotation is committed, no alert is stored; the next pull opens it", async () => {
    const { outletId, own } = await cloudOutlet();
    await cloudPull(outletId, own, { report: new Map() });
    await cloudPull(outletId, own, { report: new Map([["P1", 3]]) });
    await cloudPull(outletId, own, { report: new Map([["P1", 1]]) });
    await cloudPull(outletId, own, { report: new Map([["P2", 5]]) });
    expect(await alertRows(own.edgeNodeId)).toHaveLength(0);

    // Test-only trigger, scoped to this node: every write of its alert fails.
    const name = `t25_${randomUUID().replaceAll("-", "_")}`;
    await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.edge_node_id::text = TG_ARGV[0] THEN
          RAISE EXCEPTION 'forced alert write failure';
        END IF;
        RETURN NEW;
      END $$`);
    try {
      await owner.query(`CREATE TRIGGER ${name}
        BEFORE INSERT OR UPDATE ON edge_node_alerts FOR EACH ROW
        EXECUTE FUNCTION public.${name}('${own.edgeNodeId}')`);

      // Second regression: rotates P2 -> P3 and the alert becomes true.
      const page = await cloudPull(outletId, own, {
        report: new Map([["P2", 2]]),
      });
      expect(prefixes(page)).toEqual(["P3"]);
      expect(page.receiptRunAlert).toBe(true);

      // The receipt claim is committed (the rotation and the high-water).
      const rows = await sequenceRows(outletId);
      expect(seqOf(rows, "P2")).toMatchObject({
        retired_reason: "edge_regressed",
        edge_reported_number: 5,
      });
      expect(seqOf(rows, "P3").retired_at).toBeNull();
      // The alert write failed inside its savepoint: nothing stored.
      expect(await alertRows(own.edgeNodeId)).toHaveLength(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${name} ON edge_node_alerts`);
      await owner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
    }

    // With the failure gone the next alert pull opens the alert normally.
    const next = await cloudPull(outletId, own, {
      report: new Map([["P3", 9]]),
    });
    expect(next.receiptRunAlert).toBe(true);
    expect(openRows(await alertRows(own.edgeNodeId))).toHaveLength(1);
  });
});
