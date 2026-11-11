// Super Admin payment gateway registry (sub-302 Slice B, D7, D9-D11, D27).
// Real Express app, Better Auth and PostgreSQL. The gateway table is global,
// so every test restores the seeded rows (doit on and default, duitku off).
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  unconfiguredPaymentGateway,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  gatewaySecretGraceMs,
  gatewayWebhookTolerance,
  isPlatformGatewayEnabled,
  listPlatformGateways,
  platformDefaultGateway,
  resetPlatformGatewayCache,
} from "../services/platform-payment-gateway.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const port = (provider: string): PaymentGatewayPort => ({
  ...unconfiguredPaymentGateway,
  provider,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  isDefault: false,
  webhookTolerancePastSec: 90000,
  webhookToleranceFutureSec: 300,
  secretGraceHours: 72,
  reason: "Uji panel",
  ...overrides,
});

async function restoreSeed() {
  // Two statements: the one-default index is checked row by row.
  await owner.query("UPDATE platform_payment_gateways SET is_default = false");
  await owner.query(
    `UPDATE platform_payment_gateways SET
       enabled = (provider = 'doit'), is_default = (provider = 'doit'),
       webhook_tolerance_past_sec = 90000, webhook_tolerance_future_sec = 300,
       secret_grace_hours = 72, updated_by = NULL`,
  );
  resetPlatformGatewayCache();
}

async function admin(mfa = true) {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [session.body.user.id],
  );
  if (mfa) await verifySessionMfa(email);
  return { client, userId: session.body.user.id as string };
}

beforeEach(async () => {
  await restoreSeed();
  resetPaymentGateways();
  registerPaymentGateway(port("doit"));
  registerPaymentGateway(port("duitku"));
});

afterEach(async () => {
  await restoreSeed();
  resetPaymentGateways();
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins");
  await owner.end();
});

describe("platform payment gateway migration 0211", () => {
  it("seeds doit (on, default) and duitku (off) and appends only to history", async () => {
    const rows = await owner.query(
      "SELECT provider, display_name, enabled, is_default FROM platform_payment_gateways ORDER BY provider",
    );
    expect(rows.rows).toEqual([
      {
        provider: "doit",
        display_name: "DOIT",
        enabled: true,
        is_default: true,
      },
      {
        provider: "duitku",
        display_name: "Duitku",
        enabled: false,
        is_default: false,
      },
    ]);
    await expect(
      owner.query(
        "UPDATE platform_payment_gateways SET enabled = true, is_default = true WHERE provider = 'duitku'",
      ),
    ).rejects.toThrow(); // one default only
    await expect(
      owner.query(
        "UPDATE platform_payment_gateways SET enabled = false WHERE provider = 'doit'",
      ),
    ).rejects.toThrow(); // default must be enabled
  });
});

describe("platform payment gateway API", () => {
  it("answers 401 anonymous, 403 for a non-admin and MFA_REQUIRED without MFA", async () => {
    expect(
      (await agent(app).get("/api/platform/payment-gateways")).status,
    ).toBe(401);
    const user = agent(app);
    await signUp(user, "Biasa");
    expect((await user.get("/api/platform/payment-gateways")).status).toBe(403);
    const legacy = agent(app);
    await setRole(await signUp(legacy, "Legacy Admin"), "admin");
    expect((await legacy.get("/api/platform/payment-gateways")).status).toBe(
      403,
    );
    const noMfa = await admin(false);
    const denied = await noMfa.client
      .put("/api/platform/payment-gateways/duitku")
      .set(originHeader)
      .send(body());
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("MFA_REQUIRED");
    const [row] = (await listPlatformGateways()).filter(
      (gateway) => gateway.provider === "duitku",
    );
    expect(row?.enabled).toBe(false);
  });

  it("lists the gateways and refuses an untrusted origin and a bad body", async () => {
    const { client } = await admin();
    const list = await client.get("/api/platform/payment-gateways");
    expect(list.status).toBe(200);
    expect(
      list.body.data.map((row: { provider: string }) => row.provider),
    ).toEqual(["doit", "duitku"]);
    expect(
      (
        await client
          .put("/api/platform/payment-gateways/duitku")
          .set({ Origin: "https://untrusted.example" })
          .send(body())
      ).status,
    ).toBe(403);
    for (const bad of [
      body({ webhookTolerancePastSec: 10 }),
      body({ secretGraceHours: 0 }),
      body({ reason: "" }),
      { ...body(), extra: true },
    ])
      expect(
        (
          await client
            .put("/api/platform/payment-gateways/duitku")
            .set(originHeader)
            .send(bad)
        ).status,
      ).toBe(422);
    expect(
      (
        await client
          .put("/api/platform/payment-gateways/stripe")
          .set(originHeader)
          .send(body())
      ).status,
    ).toBe(422);
  });

  it("enables a gateway, records who and why in the history, and never stores a secret", async () => {
    const { client, userId } = await admin();
    const put = await client
      .put("/api/platform/payment-gateways/duitku")
      .set(originHeader)
      .send(body({ secretGraceHours: 48, reason: "Duitku siap uji" }));
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({
      provider: "duitku",
      displayName: "Duitku",
      enabled: true,
      isDefault: false,
      secretGraceHours: 48,
      updatedBy: userId,
    });
    const history = await owner.query(
      "SELECT provider, actor_user_id, reason, before, after FROM platform_payment_gateway_changes WHERE provider = 'duitku' AND reason = 'Duitku siap uji' ORDER BY created_at DESC LIMIT 1",
    );
    expect(history.rows[0]).toMatchObject({
      provider: "duitku",
      actor_user_id: userId,
      reason: "Duitku siap uji",
      before: expect.objectContaining({ enabled: false, secretGraceHours: 72 }),
      after: expect.objectContaining({ enabled: true, secretGraceHours: 48 }),
    });
    expect(await isPlatformGatewayEnabled("duitku")).toBe(true);
    expect(await gatewaySecretGraceMs("duitku")).toBe(48 * 3_600_000);
  });

  it("keeps one default: a new default clears the old one in the same update", async () => {
    const { client } = await admin();
    const put = await client
      .put("/api/platform/payment-gateways/duitku")
      .set(originHeader)
      .send(body({ isDefault: true }));
    expect(put.status).toBe(200);
    const rows = await owner.query(
      "SELECT provider FROM platform_payment_gateways WHERE is_default",
    );
    expect(rows.rows).toEqual([{ provider: "duitku" }]);
    expect(await platformDefaultGateway()).toBe("duitku");
  });

  it("refuses to disable or unset the default gateway", async () => {
    const { client } = await admin();
    const disabled = await client
      .put("/api/platform/payment-gateways/doit")
      .set(originHeader)
      .send(body({ enabled: false, isDefault: true }));
    expect(disabled.status).toBe(422);
    const off = await client
      .put("/api/platform/payment-gateways/doit")
      .set(originHeader)
      .send(body({ enabled: false, isDefault: false }));
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe("GATEWAY_IS_DEFAULT");
    const unset = await client
      .put("/api/platform/payment-gateways/doit")
      .set(originHeader)
      .send(body({ enabled: true, isDefault: false }));
    expect(unset.body.error.code).toBe("GATEWAY_IS_DEFAULT");
    expect(await platformDefaultGateway()).toBe("doit");
    const none = await owner.query(
      "SELECT count(*)::int AS n FROM platform_payment_gateway_changes WHERE provider = 'doit'",
    );
    expect(none.rows[0].n).toBe(0);
  });

  it("refuses to enable a gateway that has no registered adapter", async () => {
    resetPaymentGateways();
    registerPaymentGateway(port("doit"));
    const { client } = await admin();
    const put = await client
      .put("/api/platform/payment-gateways/duitku")
      .set(originHeader)
      .send(body());
    expect(put.status).toBe(422);
    expect(put.body.error.code).toBe("GATEWAY_NOT_REGISTERED");
  });

  it("serves tolerance and grace from the row and defaults when the row is missing", async () => {
    const { client } = await admin();
    await client
      .put("/api/platform/payment-gateways/doit")
      .set(originHeader)
      .send(
        body({
          isDefault: true,
          webhookTolerancePastSec: 3600,
          webhookToleranceFutureSec: 60,
        }),
      );
    expect(await gatewayWebhookTolerance("doit")).toEqual({
      pastMs: 3_600_000,
      futureMs: 60_000,
    });
    expect(await gatewayWebhookTolerance("unknown")).toEqual({
      pastMs: 25 * 3_600_000,
      futureMs: 300_000,
    });
    expect(await gatewaySecretGraceMs("unknown")).toBe(72 * 3_600_000);
    expect(await isPlatformGatewayEnabled("unknown")).toBe(false);
  });
});
