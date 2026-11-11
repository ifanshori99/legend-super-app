// legend-488 item 11 (Codex finding docs/deployment.md:359): after a rollback
// to blind-index version 1 the build must still read idempotency fingerprints
// stored under version 2, so a retry around the switch replays the stored
// response instead of running the write again (or failing with a false
// IDEMPOTENCY_KEY_REUSED). Mirror of the v1-under-active-2 cases in
// blind-index-writers-db.test.ts. Separate file: the active version is read
// from the environment when the config loads.
//
// Assumptions: the v2 fingerprint is
// blindIndexAt(2, JSON.stringify({ operation, request }), `hris:idempotency:${tenant}`)
// and `idempotentHrisWrite(tx, scope, key, operation, request, run)` is the
// public entry used by the writers tests.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BLIND_INDEX_ACTIVE_VERSION = "1";
});

import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
} from "../lib/blind-index.ts";
import { idempotentHrisWrite } from "../services/hris-employee.service.ts";
import {
  asOwner,
  newFixture,
  scope,
  setupTenants,
  teardown,
} from "./blind-index-fixtures.ts";

const fx = newFixture(1);
const tenant = fx.tenants[0]!;
const operation = "blind_index.rollback";
const request = { actor: "a", values: { n: 1 } };
const fingerprintAt = (version: 1 | 2) =>
  blindIndexAt(
    version,
    JSON.stringify({ operation, request }),
    `hris:idempotency:${tenant}`,
  );

async function replay(
  key: string,
  op: string,
  req: unknown,
  ran: { count: number },
) {
  return withTenant(db, scope(tenant), (tx) =>
    idempotentHrisWrite(tx, scope(tenant), key, op, req, async () => {
      ran.count += 1;
      return { ok: true, fresh: true };
    }),
  );
}

async function storeV2(key: string): Promise<void> {
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO hris_idempotency (tenant_id, key, operation, fingerprint, response)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenant,
        key,
        operation,
        fingerprintAt(2),
        JSON.stringify({ stored: "v2" }),
      ],
    ),
  );
}

beforeAll(async () => {
  await setupTenants(fx, "blind-index-idem-rollback");
});

afterAll(async () => {
  await teardown(fx);
});

describe("legend-488 idempotency fingerprints after rollback to v1", () => {
  it("runs with active version 1", () => {
    expect(BLIND_INDEX_ACTIVE_VERSION).toBe(1);
  });

  it("[HR-03] the same request replays a response stored under a v2 fingerprint", async () => {
    const key = `bi-rb-replay-${randomUUID()}`;
    await storeV2(key);
    const ran = { count: 0 };
    await expect(replay(key, operation, request, ran)).resolves.toEqual({
      stored: "v2",
    });
    expect(ran.count).toBe(0);
  });

  it("[HR-03] a different request or operation with a v2 fingerprint is IDEMPOTENCY_KEY_REUSED", async () => {
    const key = `bi-rb-reused-${randomUUID()}`;
    await storeV2(key);
    const ran = { count: 0 };
    await expect(
      replay(key, operation, { ...request, values: { n: 2 } }, ran),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      replay(key, "other.operation", request, ran),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(ran.count).toBe(0);
  });

  it("[HR-03] a fresh key stores the active (v1) fingerprint and replays", async () => {
    const key = `bi-rb-fresh-${randomUUID()}`;
    const ran = { count: 0 };
    await replay(key, operation, request, ran);
    expect(ran.count).toBe(1);
    const stored = await asOwner(tenant, (client) =>
      client.query(
        "SELECT fingerprint FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
        [tenant, key],
      ),
    );
    expect(stored.rows[0].fingerprint).toBe(fingerprintAt(1));
    await expect(replay(key, operation, request, ran)).resolves.toEqual({
      ok: true,
      fresh: true,
    });
    expect(ran.count).toBe(1);
  });
});
