// Kartu C item 2 (bead legend-39d.4): the TL-15 promotion executor is
// idempotent per action request through a dedicated column, not through an
// `[ai:<id>]` marker in the promotion description. MONEY: a retried execution
// must never create a second promotion (a second discount the outlet pays).
//
// Written from the brief, not from the implementation. Same harness as
// ai-action-executor-rollback.test.ts: real PostgreSQL, the executor called
// directly with the requester's access.
//
// ASSUMPTIONS (listed in the report):
//  - Column: `promotions.ai_action_request_id` (uuid, nullable: manual promos
//    have none) with a UNIQUE index covering it.
//  - The promotion description no longer carries `[ai:<id>]`.
//  - A repeated run of the SAME action request either returns the first run's
//    `resultRef` or throws an ActionExecutionError; in both cases exactly one
//    promotion exists and it stays active (the retry's compensation must not
//    end the original).
//  - Two DIFFERENT action requests with an identical payload make two
//    promotions (the key is the request, not the promotion name).
//  - The promotion `name` column holds the payload name (used to count rows).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { executePromotion } from "../services/ai-action-executors/promotion.ts";
import {
  ActionExecutionError,
  type ActionRequestRow,
} from "../services/ai-action-executors/types.ts";
import {
  cleanupAcceptance,
  grantCustomRole,
  outletA,
  ownerPool,
  signedIn,
  tenantId,
} from "./ai-acceptance-helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

async function manager() {
  const actor = await signedIn("Pengelola Idempotensi Promo");
  await grantCustomRole(
    actor.userId,
    ["menu.item.view", "menu.item.manage", "menu.price.manage", "promo.manage"],
    { type: "tenant" },
  );
  const data = await loadTenantAccess(workerContext, actor.userId);
  const access = resolveAccessSnapshot({
    tenant,
    userId: actor.userId,
    ...data,
    mfaVerified: true,
    now: new Date(),
  });
  return { actor, access };
}
type Manager = Awaited<ReturnType<typeof manager>>;

const payloadOf = (name: string) => ({
  name,
  outletIds: [outletA],
  startsAt: "2040-01-01T00:00:00.000Z",
  endsAt: "2040-02-01T00:00:00.000Z",
  discount: { kind: "percent", percent: "10.0000" },
});

const rowOf = (
  who: Manager,
  payload: unknown,
  id: string = randomUUID(),
): ActionRequestRow =>
  ({
    id,
    tenantId,
    requestedByUserId: who.actor.userId,
    toolCode: "TL-15",
    payload,
  }) as unknown as ActionRequestRow;

const run = (who: Manager, row: ActionRequestRow) =>
  executePromotion({
    tx: undefined as never,
    context: workerContext,
    access: who.access,
    row,
    now: new Date(),
  });

const uniqueName = () => `Promo idempotensi ${randomUUID().slice(0, 8)}`;

async function promotionsNamed(name: string) {
  const { rows } = await ownerPool.query(
    "SELECT id, status, description, ai_action_request_id FROM promotions WHERE tenant_id = $1 AND name = $2",
    [tenantId, name],
  );
  return rows as {
    id: string;
    status: string;
    description: string | null;
    ai_action_request_id: string | null;
  }[];
}

/** The key lives in the dedicated column, never as an `[ai:` marker. */
function expectKeyedBy(
  promo: Awaited<ReturnType<typeof promotionsNamed>>[number],
  requestId: string,
) {
  expect(promo.ai_action_request_id).toBe(requestId);
  expect(promo.description ?? "").not.toContain("[ai:");
}

afterAll(async () => {
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

describe("TL-15 promotion executor: idempotency column (legend-39d.4)", () => {
  it("legend-39d.4 a repeated execution of one action request leaves exactly one active promotion", async () => {
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));

    const first = await run(who, row);
    expect(first.resultRef).toMatch(/^promotion:/);
    const second = await run(who, row).catch((error: unknown) => error);

    if (second instanceof Error)
      expect(second).toBeInstanceOf(ActionExecutionError);
    else expect(second).toMatchObject({ resultRef: first.resultRef });

    const promos = await promotionsNamed(name);
    expect(promos).toHaveLength(1);
    expect(promos[0]!.status).toBe("active");
    expectKeyedBy(promos[0]!, row.id);
    expect(first.resultRef).toBe(`promotion:${promos[0]!.id}`);
  }, 60_000);

  it("legend-39d.4 many retries still leave one promotion", async () => {
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));
    await run(who, row);
    for (let i = 0; i < 3; i++) await run(who, row).catch(() => undefined);
    const promos = await promotionsNamed(name);
    expect(promos).toHaveLength(1);
    expect(promos[0]!.status).toBe("active");
    expectKeyedBy(promos[0]!, row.id);
  }, 90_000);

  it("legend-39d.4 two executions racing on one action request make one promotion", async () => {
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));
    await Promise.allSettled([run(who, row), run(who, row)]);
    const promos = await promotionsNamed(name);
    expect(promos).toHaveLength(1);
    expect(promos[0]!.status).toBe("active");
    expectKeyedBy(promos[0]!, row.id);
  }, 60_000);

  it("legend-39d.4 two different action requests with the same payload make two promotions", async () => {
    const who = await manager();
    const name = uniqueName();
    const rowOne = rowOf(who, payloadOf(name));
    const rowTwo = rowOf(who, payloadOf(name));
    await run(who, rowOne);
    await run(who, rowTwo);
    const promos = await promotionsNamed(name);
    expect(promos).toHaveLength(2);
    expect(promos.every((promo) => promo.status === "active")).toBe(true);
    // Each promotion is keyed by its own request, with no marker in the text.
    for (const promo of promos)
      expect(promo.description ?? "").not.toContain("[ai:");
    expect(promos.map((promo) => promo.ai_action_request_id).sort()).toEqual(
      [rowOne.id, rowTwo.id].sort(),
    );
  }, 90_000);

  it("legend-39d.4 the description no longer carries the [ai:<id>] marker", async () => {
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));
    await run(who, row);
    const [promo] = await promotionsNamed(name);
    expect(promo!.description ?? "").not.toContain("[ai:");
    expect(promo!.description ?? "").not.toContain(row.id);
  }, 60_000);

  it("legend-39d.4 the request id is stored in promotions.ai_action_request_id", async () => {
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));
    await run(who, row);
    const { rows } = await ownerPool.query(
      "SELECT ai_action_request_id FROM promotions WHERE tenant_id = $1 AND name = $2",
      [tenantId, name],
    );
    expect(rows).toEqual([{ ai_action_request_id: row.id }]);
  }, 60_000);
});

describe("promotions.ai_action_request_id schema (legend-39d.4)", () => {
  it("legend-39d.4 is nullable and backed by a unique index", async () => {
    const column = await ownerPool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'promotions' AND column_name = 'ai_action_request_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "YES" }]);
    const indexes = await ownerPool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'promotions' AND indexdef ILIKE '%ai_action_request_id%'`,
    );
    expect(
      indexes.rows.some((entry: { indexdef: string }) =>
        /CREATE UNIQUE INDEX/i.test(entry.indexdef),
      ),
    ).toBe(true);
  });

  it("legend-39d.4 the migration backfills old [ai:<id>] rows, so a retry after deploy stays safe", async () => {
    // Build a pre-migration row: key empty, marker in the description. Then run
    // the backfill statement of migration 0446 itself, and retry the request.
    const who = await manager();
    const name = uniqueName();
    const row = rowOf(who, payloadOf(name));
    await run(who, row);
    await ownerPool.query(
      `UPDATE promotions SET ai_action_request_id = NULL,
              description = coalesce(description, '') || ' [ai:' || $3 || ']'
        WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name, row.id],
    );
    const sqlText = readFileSync(
      resolve(
        import.meta.dirname,
        "../../drizzle/0446_promotion_ai_action_request_key.sql",
      ),
      "utf8",
    );
    const backfill = /WITH marked AS[\s\S]*?marked\.rn = 1;/.exec(sqlText)?.[0];
    expect(backfill, "backfill statement in migration 0446").toBeTruthy();
    await ownerPool.query(backfill!);
    const { rows } = await ownerPool.query(
      "SELECT ai_action_request_id FROM promotions WHERE tenant_id = $1 AND name = $2",
      [tenantId, name],
    );
    expect(rows).toEqual([{ ai_action_request_id: row.id }]);
    await run(who, row).catch(() => undefined);
    expect(await promotionsNamed(name)).toHaveLength(1);
  }, 60_000);
});
