// 1272 K5 review P2: the C4a fee caps (`maxFee*` in an integration config)
// are written by the platform only. A tenant or outlet admin cannot raise a
// cap, so a guest fee can never be set above what the platform allowed; the
// cap check reads the stored cap, not the request body.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  isPlatformFeeCapWriter,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import { HttpError } from "../lib/http-error.ts";

const tenantId = randomUUID();
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const ctx: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

const LIMITS = {
  maxOutlets: 1,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 3,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 10_000,
  emailCostCapIdr: 1_000,
};
const BASE = {
  environment: "sandbox",
  notificationEmail: "kas@cafe.test",
  maxFeeBps_va: 0,
  maxFeeFlatIdr_va: 5_000,
};
const save = (
  config: Record<string, unknown>,
  options?: { platform?: boolean },
) =>
  upsertIntegration(
    ctx,
    { outletId: null, provider: "duitku", config } as Parameters<
      typeof upsertIntegration
    >[1],
    actor,
    options,
  );
const storedConfig = async () =>
  (
    await owner.query<{ config: Record<string, unknown> }>(
      "SELECT config FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
      [tenantId],
    )
  ).rows[0]?.config;
const refusal = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant K5', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["doit","duitku"]}', $3, $4)`,
    [
      tenantId,
      `uji-k5-${randomBytes(4).toString("hex")}`,
      JSON.stringify(LIMITS),
      actor,
    ],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    tenantId,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await owner.end();
});

describe("maxFee* caps are platform-only (K5 review P2)", () => {
  it("a tenant admin cannot create a row with caps", async () => {
    const error = await refusal(() => save(BASE));
    expect(error.status).toBe(403);
    expect(error.code).toBe("DUITKU_FEE_CAP_PLATFORM_ONLY");
    expect(await storedConfig()).toBeUndefined();
  });

  it("the platform sets the caps, a tenant admin saves with them unchanged", async () => {
    await save(BASE, { platform: true });
    expect(await storedConfig()).toMatchObject(BASE);
    await save({
      ...BASE,
      guestFees: { BC: { bps: 0, flatIdr: 4_000 } },
    });
    expect((await storedConfig())?.guestFees).toEqual({
      BC: { bps: 0, flatIdr: 4_000 },
    });
  });

  it("a tenant admin cannot raise, add or drop a cap, nor sneak a rate over the cap", async () => {
    for (const config of [
      {
        ...BASE,
        maxFeeBps_va: 10_000,
        guestFees: { BC: { bps: 9_999, flatIdr: 0 } },
      },
      { ...BASE, maxFeeFlatIdr_va: 9_000 },
      { ...BASE, maxFeeBps_ewallet: 300 },
      { environment: "sandbox", notificationEmail: "kas@cafe.test" },
    ]) {
      const error = await refusal(() => save(config));
      expect(error.code).toBe("DUITKU_FEE_CAP_PLATFORM_ONLY");
    }
    // Same caps as stored: the rate is still checked against the stored cap.
    const over = await refusal(() =>
      save({ ...BASE, guestFees: { BC: { bps: 0, flatIdr: 5_001 } } }),
    );
    expect(over.code).toBe("VALIDATION_ERROR");
    expect((await storedConfig())?.maxFeeBps_va).toBe(0);
    expect((await storedConfig())?.maxFeeFlatIdr_va).toBe(5_000);
  });

  it("only a read_write support grant counts as the platform", () => {
    expect(isPlatformFeeCapWriter(null)).toBe(false);
    expect(isPlatformFeeCapWriter({ accessMode: "read_only" })).toBe(false);
    expect(isPlatformFeeCapWriter({ accessMode: "read_write" })).toBe(true);
  });

  it("the audit records the old and new cap values", async () => {
    await save(
      { ...BASE, maxFeeFlatIdr_va: 6_000, maxFeeBps_card: 100 },
      { platform: true },
    );
    type Caps = { capKey: string; capValue: number }[];
    const { rows } = await owner.query<{
      event: {
        maskedChanges: {
          before: { feeCaps: Caps };
          after: { feeCaps: Caps };
        };
      };
    }>(
      `SELECT event FROM audit_logs WHERE tenant_id = $1
       AND event->>'action' = 'integration.config.updated'
       ORDER BY event->>'createdAt' DESC LIMIT 1`,
      [tenantId],
    );
    const { before, after } = rows[0]!.event.maskedChanges;
    expect(before.feeCaps).toContainEqual({
      capKey: "maxFeeFlatIdr_va",
      capValue: 5_000,
    });
    expect(after.feeCaps).toContainEqual({
      capKey: "maxFeeFlatIdr_va",
      capValue: 6_000,
    });
    expect(after.feeCaps).toContainEqual({
      capKey: "maxFeeBps_card",
      capValue: 100,
    });
    await save(BASE, { platform: true });
  });

  it("guestFees belong to Duitku only", async () => {
    const error = await refusal(() =>
      upsertIntegration(
        ctx,
        {
          outletId: null,
          provider: "doit",
          config: { guestFees: { BC: { bps: 0, flatIdr: 1 } } },
        } as Parameters<typeof upsertIntegration>[1],
        actor,
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });
});
