// legend-fjk5 (FAC-04, FAC-05): migration 0215 entitlement_ledger. The ledger
// is append-only (trigger for the owner, REVOKE for legend_app), a redeem /
// cancel / expire row cannot draw more sessions than its grant has left, and
// tenant + outlet RLS keep rows apart.
//
// Every check runs in one owner transaction that is ROLLED BACK (the ledger
// cannot be cleaned up by DELETE): fixtures are written as the migration owner
// with the tenant settings set, checks switch to legend_app. A failing
// statement runs behind a savepoint so the transaction stays usable.
//
// Assumptions: legend_app holds SELECT/INSERT on the table (default
// privileges); errors are asserted by SQLSTATE (42501 permission or RLS,
// 23514 overdraw).
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness";

const outletA1 = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletA2 = cafeLegendPlatformFixtures.outlets[1]!.id;

let owner: Pool;
let tenantB: SecondTenant;

function setTenant(
  client: PoolClient,
  tenantId: string,
  outletIds: "*" | string[] = "*",
) {
  return client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
    [tenantId, outletIds === "*" ? "*" : JSON.stringify(outletIds)],
  );
}

async function insertFacility(
  client: PoolClient,
  tenantId: string,
  outletId: string,
): Promise<string> {
  const id = randomUUID();
  await setTenant(client, tenantId);
  await client.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Ent test', 'shower', 20, 10, 10, $4, $5, $6)`,
    [
      id,
      tenantId,
      outletId,
      JSON.stringify([
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "00:00",
          closesAt: "23:59",
        },
      ]),
      JSON.stringify({
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      }),
      JSON.stringify({
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      }),
    ],
  );
  return id;
}

interface RowInput {
  tenantId: string;
  outletId: string;
  facilityId: string;
  customerProfileId: string;
  type: "grant" | "redeem" | "cancel" | "expire";
  sessions?: number;
  grantEntryId?: string | null;
  accessTicketId?: string | null;
  sourceRef?: string;
}

async function insertRow(client: PoolClient, input: RowInput): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO entitlement_ledger (id, tenant_id, outlet_id, facility_id, customer_profile_id,
                                     type, sessions, source_type, source_ref, grant_entry_id, access_ticket_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'staff_issue', $8, $9, $10)`,
    [
      id,
      input.tenantId,
      input.outletId,
      input.facilityId,
      input.customerProfileId,
      input.type,
      input.sessions ?? 1,
      input.sourceRef ?? randomUUID().slice(0, 36),
      input.grantEntryId ?? null,
      input.accessTicketId ?? null,
    ],
  );
  return id;
}

/** Runs `run` in a rolled-back owner transaction; the owner role is active. */
async function inRolledBackTx<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** The statement must fail with `code`; the transaction stays usable. */
async function expectFails(
  client: PoolClient,
  code: string,
  statement: () => Promise<unknown>,
  label: string,
) {
  await client.query("SAVEPOINT expect_fail");
  let failure: { code?: string } | null = null;
  try {
    await statement();
  } catch (error) {
    failure = error as { code?: string };
  }
  await client.query("ROLLBACK TO SAVEPOINT expect_fail");
  expect(failure, `${label}: statement was accepted`).not.toBeNull();
  expect(failure?.code, label).toBe(code);
}

beforeAll(async () => {
  requireDisposableDatabase();
  owner = createOwnerPool();
  tenantB = await createSecondTenant(owner, "entitlement");
});

afterAll(async () => {
  await removeSecondTenant(owner, tenantB);
  await owner.end();
});

describe("FAC-05 the entitlement ledger is append-only", () => {
  it("[FAC-05] UPDATE and DELETE are refused to legend_app and to the owner", async () => {
    await inRolledBackTx(async (client) => {
      const facilityId = await insertFacility(client, tenantAId, outletA1);
      const customerProfileId = randomUUID();
      const grant = await insertRow(client, {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId,
        customerProfileId,
        type: "grant",
        sessions: 3,
      });

      // Owner: only the trigger stands in the way.
      await expectFails(
        client,
        "42501",
        () =>
          client.query(
            "UPDATE entitlement_ledger SET sessions = 9 WHERE id = $1",
            [grant],
          ),
        "owner update",
      );
      await expectFails(
        client,
        "42501",
        () =>
          client.query("DELETE FROM entitlement_ledger WHERE id = $1", [grant]),
        "owner delete",
      );
      await expectFails(
        client,
        "42501",
        () => client.query("TRUNCATE entitlement_ledger"),
        "owner truncate",
      );

      // legend_app: the privilege is revoked.
      await client.query("SET LOCAL ROLE legend_app");
      await setTenant(client, tenantAId);
      await expectFails(
        client,
        "42501",
        () =>
          client.query(
            "UPDATE entitlement_ledger SET sessions = 9 WHERE id = $1",
            [grant],
          ),
        "app update",
      );
      await expectFails(
        client,
        "42501",
        () =>
          client.query("DELETE FROM entitlement_ledger WHERE id = $1", [grant]),
        "app delete",
      );
      const read = await client.query(
        "SELECT sessions FROM entitlement_ledger WHERE id = $1",
        [grant],
      );
      expect(read.rows).toEqual([{ sessions: 3 }]);
    });
  });
});

describe("FAC-05 a grant cannot be drawn down past its sessions", () => {
  it("[FAC-05] a second redeem of a one-session grant and a cancel after it are refused", async () => {
    await inRolledBackTx(async (client) => {
      const facilityId = await insertFacility(client, tenantAId, outletA1);
      const customerProfileId = randomUUID();
      const base = {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId,
        customerProfileId,
      };
      const grant = await insertRow(client, {
        ...base,
        type: "grant",
        sessions: 1,
      });
      await client.query("SET LOCAL ROLE legend_app");
      await setTenant(client, tenantAId);

      await insertRow(client, {
        ...base,
        type: "redeem",
        grantEntryId: grant,
        accessTicketId: randomUUID(),
      });
      await expectFails(
        client,
        "23514",
        () =>
          insertRow(client, {
            ...base,
            type: "redeem",
            grantEntryId: grant,
            accessTicketId: randomUUID(),
          }),
        "second redeem",
      );
      await expectFails(
        client,
        "23514",
        () =>
          insertRow(client, { ...base, type: "cancel", grantEntryId: grant }),
        "cancel of a spent grant",
      );
    });
  });

  it("[FAC-05] a cancel larger than the remainder is refused, the exact remainder passes", async () => {
    await inRolledBackTx(async (client) => {
      const facilityId = await insertFacility(client, tenantAId, outletA1);
      const base = {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId,
        customerProfileId: randomUUID(),
      };
      const grant = await insertRow(client, {
        ...base,
        type: "grant",
        sessions: 3,
      });
      await client.query("SET LOCAL ROLE legend_app");
      await setTenant(client, tenantAId);
      await insertRow(client, {
        ...base,
        type: "redeem",
        grantEntryId: grant,
        accessTicketId: randomUUID(),
      });
      await expectFails(
        client,
        "23514",
        () =>
          insertRow(client, {
            ...base,
            type: "cancel",
            grantEntryId: grant,
            sessions: 3,
          }),
        "cancel over the remainder",
      );
      await insertRow(client, {
        ...base,
        type: "cancel",
        grantEntryId: grant,
        sessions: 2,
      });
    });
  });

  it("[FAC-05] the same ticket cannot redeem twice, a row cannot name another customer's grant", async () => {
    await inRolledBackTx(async (client) => {
      const facilityId = await insertFacility(client, tenantAId, outletA1);
      const base = {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId,
        customerProfileId: randomUUID(),
      };
      const grant = await insertRow(client, {
        ...base,
        type: "grant",
        sessions: 5,
      });
      const ticket = randomUUID();
      await insertRow(client, {
        ...base,
        type: "redeem",
        grantEntryId: grant,
        accessTicketId: ticket,
      });
      await expectFails(
        client,
        "23505",
        () =>
          insertRow(client, {
            ...base,
            type: "redeem",
            grantEntryId: grant,
            accessTicketId: ticket,
          }),
        "same ticket twice",
      );
      await expectFails(
        client,
        "23514",
        () =>
          insertRow(client, {
            ...base,
            customerProfileId: randomUUID(),
            type: "redeem",
            grantEntryId: grant,
            accessTicketId: randomUUID(),
          }),
        "other customer",
      );
    });
  });
});

describe("TEN-01 tenant and outlet isolation of entitlement_ledger", () => {
  it("[TEN-01] a tenant sees only its own rows and cannot write for another tenant", async () => {
    await inRolledBackTx(async (client) => {
      const facilityA = await insertFacility(client, tenantAId, outletA1);
      const facilityB = await insertFacility(
        client,
        tenantB.tenantId,
        tenantB.outletId,
      );
      const rowA = await insertRow(client, {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId: facilityA,
        customerProfileId: randomUUID(),
        type: "grant",
      });
      await setTenant(client, tenantB.tenantId);
      const rowB = await insertRow(client, {
        tenantId: tenantB.tenantId,
        outletId: tenantB.outletId,
        facilityId: facilityB,
        customerProfileId: randomUUID(),
        type: "grant",
      });
      const both = [rowA, rowB];

      await client.query("SET LOCAL ROLE legend_app");
      await setTenant(client, tenantAId);
      const seenA = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM entitlement_ledger WHERE id = ANY($1::uuid[])",
        [both],
      );
      expect(seenA.rows.map((r) => r.id)).toEqual([rowA]);
      await expectFails(
        client,
        "42501",
        () =>
          insertRow(client, {
            tenantId: tenantB.tenantId,
            outletId: tenantB.outletId,
            facilityId: facilityB,
            customerProfileId: randomUUID(),
            type: "grant",
          }),
        "tenant A writes a tenant B row",
      );

      await setTenant(client, tenantB.tenantId);
      const seenB = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM entitlement_ledger WHERE id = ANY($1::uuid[])",
        [both],
      );
      expect(seenB.rows.map((r) => r.id)).toEqual([rowB]);
    });
  });

  it("[TEN-01] a session scoped to another outlet sees and writes nothing of this outlet", async () => {
    await inRolledBackTx(async (client) => {
      const facilityId = await insertFacility(client, tenantAId, outletA1);
      const row = await insertRow(client, {
        tenantId: tenantAId,
        outletId: outletA1,
        facilityId,
        customerProfileId: randomUUID(),
        type: "grant",
      });
      await client.query("SET LOCAL ROLE legend_app");
      await setTenant(client, tenantAId, [outletA2]);
      const seen = await client.query(
        "SELECT id FROM entitlement_ledger WHERE id = $1",
        [row],
      );
      expect(seen.rows).toEqual([]);
      await expectFails(
        client,
        "42501",
        () =>
          insertRow(client, {
            tenantId: tenantAId,
            outletId: outletA1,
            facilityId,
            customerProfileId: randomUUID(),
            type: "grant",
          }),
        "outlet A2 session writes an outlet A1 row",
      );
      await setTenant(client, tenantAId, [outletA1]);
      const own = await client.query(
        "SELECT id FROM entitlement_ledger WHERE id = $1",
        [row],
      );
      expect(own.rows).toHaveLength(1);
    });
  });
});
