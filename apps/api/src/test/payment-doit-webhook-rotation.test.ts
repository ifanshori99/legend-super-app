// DOIT webhook secret rotation and the per-gateway timestamp window (sub-brief
// 302 Slice D; design D17-D19).
//
// - Replacing the webhook secret keeps the old one valid until
//   `previousValidUntil` (one generation), then refuses it, even from the
//   60 s cache; the new secret always verifies.
// - The signature timestamp window comes from the platform gateway row
//   (`gatewayWebhookTolerance("doit")`), not from a constant. The constant
//   stays the default of `verifyDoitSignature`.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  clearDoitWebhookSecretCache,
  receiveDoitWebhook,
} from "../services/payment-webhook.service";
import {
  DOIT_SIGNATURE_TOLERANCE,
  verifyDoitSignature,
} from "../services/payment-doit-wire";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

// The platform gateway row is Slice B's; here only its two readers matter.
const platform = vi.hoisted(() => ({
  tolerance: { pastMs: 25 * 3_600_000, futureMs: 5 * 60_000 },
}));
vi.mock("../services/platform-payment-gateway.service", async (original) => ({
  ...(await original<
    typeof import("../services/platform-payment-gateway.service")
  >()),
  gatewayWebhookTolerance: async () => platform.tolerance,
  gatewaySecretGraceMs: async () => 72 * 3_600_000,
}));

// Installs the audit writer the credential service needs.
createApp();

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const integrationIds: string[] = [];
const eventIds: string[] = [];

const oldSecret = `whsec-rot-old-${randomBytes(12).toString("hex")}`;
const newSecret = `whsec-rot-new-${randomBytes(12).toString("hex")}`;
const HOUR = 3_600_000;

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const credentials = (webhookSecret: string) => ({
  apiKey: "doit-key-rotation",
  webhookSecret,
});

function sign(raw: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

/** A stored-and-ignored event type: enough to see whether the signature
 * verified (resolves) or not (UNAUTHORIZED). */
function deliver(secret: string, now: Date, signedAt: Date = now) {
  const id = `evt_${randomBytes(8).toString("hex")}`;
  eventIds.push(id);
  const raw = JSON.stringify({
    id,
    type: "webhook.test",
    created_at: now.toISOString(),
    data: {},
  });
  return receiveDoitWebhook({
    tenantId: tenantA,
    rawBody: Buffer.from(raw),
    signatureHeader: sign(raw, secret, signedAt),
    now,
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
    [tenantA, eventIds],
  );
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.end();
});

beforeEach(() => {
  platform.tolerance = { pastMs: 25 * HOUR, futureMs: 5 * 60_000 };
  clearDoitWebhookSecretCache();
});
afterEach(() => clearDoitWebhookSecretCache());

describe("D17-D18 a replaced DOIT webhook secret stays valid for the grace window only", () => {
  it("accepts the previous secret inside the window, refuses it after, always accepts the new one", async () => {
    const created = await upsertIntegration(
      context(),
      {
        outletId: null,
        provider: "doit",
        config: { baseUrl: "http://127.0.0.1:9" },
        credentials: credentials(oldSecret),
      },
      actor,
    );
    integrationIds.push(created.id);
    await setIntegrationStatus(
      context(),
      created.id,
      { status: "active" },
      actor,
    );
    const now = new Date();
    // Before rotation only the old secret exists.
    await expect(deliver(oldSecret, now)).resolves.toMatchObject({
      status: "ignored",
    });
    await expect(deliver(newSecret, now)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    await upsertIntegration(
      context(),
      {
        outletId: null,
        provider: "doit",
        config: { baseUrl: "http://127.0.0.1:9" },
        credentials: credentials(newSecret),
      },
      actor,
    );

    // Inside the grace window: both verify.
    await expect(deliver(newSecret, now)).resolves.toMatchObject({
      status: "ignored",
    });
    await expect(deliver(oldSecret, now)).resolves.toMatchObject({
      status: "ignored",
    });
    const nearEnd = new Date(now.getTime() + 71 * HOUR);
    platform.tolerance = { pastMs: 100 * HOUR, futureMs: 5 * 60_000 };
    await expect(deliver(oldSecret, nearEnd)).resolves.toMatchObject({
      status: "ignored",
    });

    // Past it: the old secret is refused, the new one still works. The cache
    // holds the entry (60 s TTL) but filters it by the clock of the request.
    const after = new Date(now.getTime() + 73 * HOUR);
    await expect(deliver(oldSecret, after)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(deliver(newSecret, after)).resolves.toMatchObject({
      status: "ignored",
    });
  });
});

describe("D19 the timestamp window is the platform's, per gateway", () => {
  it("verifyDoitSignature defaults to DOIT_SIGNATURE_TOLERANCE and honours an explicit window", () => {
    const now = new Date("2026-11-10T03:00:00.000Z");
    const raw = "{}";
    const header = (ageSeconds: number) =>
      sign(raw, oldSecret, new Date(now.getTime() - ageSeconds * 1000));
    const base = {
      rawBody: Buffer.from(raw),
      secrets: [oldSecret],
      now,
    };
    const day = 24 * 3600;
    expect(verifyDoitSignature({ ...base, header: header(day) })).toBe(true);
    expect(
      verifyDoitSignature({
        ...base,
        header: header(DOIT_SIGNATURE_TOLERANCE.pastSeconds + 60),
      }),
    ).toBe(false);
    const tight = { pastSeconds: 120, futureSeconds: 0 };
    expect(
      verifyDoitSignature({ ...base, header: header(60), tolerance: tight }),
    ).toBe(true);
    expect(
      verifyDoitSignature({ ...base, header: header(300), tolerance: tight }),
    ).toBe(false);
    // Future timestamp beyond the (zero) future window.
    expect(
      verifyDoitSignature({ ...base, header: header(-30), tolerance: tight }),
    ).toBe(false);
  });

  it("receiveDoitWebhook takes the window from gatewayWebhookTolerance('doit')", async () => {
    // Uses the integration the rotation test created (same file, in order).
    const now = new Date();
    const twoMinutesOld = new Date(now.getTime() - 2 * 60_000);
    // Wide window (default 25 h): a 2-minute-old signature verifies.
    await expect(deliver(newSecret, now, twoMinutesOld)).resolves.toMatchObject(
      { status: "ignored" },
    );
    // The platform tightens it to 60 s: the same age is refused.
    platform.tolerance = { pastMs: 60_000, futureMs: 0 };
    await expect(deliver(newSecret, now, twoMinutesOld)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    // A fresh signature still passes.
    await expect(deliver(newSecret, now)).resolves.toMatchObject({
      status: "ignored",
    });
  });
});
