// `pnpm --filter @starter/api gateway:set` (legend-0orff 0O-1): the CLI calls
// the same writer as the Super Admin API, so the change history stays written
// and the same guards hold. Real PostgreSQL; the gateway table is global, so
// every test restores the seeded rows (doit on and default, duitku off).
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  unconfiguredPaymentGateway,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  parseGatewaySetArgs,
  setPlatformGatewayFromCli,
} from "../services/platform-gateway-cli";
import {
  listPlatformGateways,
  resetPlatformGatewayCache,
} from "../services/platform-payment-gateway.service";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const port = (provider: string): PaymentGatewayPort => ({
  ...unconfiguredPaymentGateway,
  provider,
});

async function restoreSeed() {
  await owner.query("UPDATE platform_payment_gateways SET is_default = false");
  await owner.query(
    `UPDATE platform_payment_gateways SET
       enabled = (provider = 'doit'), is_default = (provider = 'doit'),
       webhook_tolerance_past_sec = 90000, webhook_tolerance_future_sec = 300,
       secret_grace_hours = 72, updated_by = NULL`,
  );
  resetPlatformGatewayCache();
}

async function state() {
  const { rows } = await owner.query(
    "SELECT provider, enabled, is_default FROM platform_payment_gateways ORDER BY provider",
  );
  return rows as { provider: string; enabled: boolean; is_default: boolean }[];
}

const changes = async () =>
  (
    await owner.query(
      "SELECT provider, actor_user_id, reason, before, after FROM platform_payment_gateway_changes WHERE actor_user_id LIKE 'system:cli%' OR actor_user_id LIKE 'ops-%' ORDER BY created_at",
    )
  ).rows;

async function cleanChanges() {
  // The history is append-only for the app role; the owner pool may clean up
  // only the rows this file wrote.
  await owner.query(
    "DELETE FROM platform_payment_gateway_changes WHERE actor_user_id LIKE 'system:cli%' OR actor_user_id LIKE 'ops-%'",
  );
}

beforeEach(async () => {
  await restoreSeed();
  await cleanChanges();
  resetPaymentGateways();
  registerPaymentGateway(port("doit"));
  registerPaymentGateway(port("duitku"));
});

afterEach(async () => {
  await restoreSeed();
  await cleanChanges();
  resetPaymentGateways();
});

afterAll(async () => {
  await owner.end();
});

const run = (...argv: string[]) =>
  setPlatformGatewayFromCli(parseGatewaySetArgs(argv));

describe("parseGatewaySetArgs", () => {
  it("accepts a provider with flags and an optional operator email", () => {
    expect(
      parseGatewaySetArgs([
        "--",
        "duitku",
        "--enabled",
        "--default",
        "--actor",
        "ops-a@example.com",
      ]),
    ).toMatchObject({
      provider: "duitku",
      enabled: true,
      makeDefault: true,
      actor: "ops-a@example.com",
    });
  });

  it.each([
    [[], "no provider"],
    [["stripe", "--enabled"], "unknown provider"],
    [["duitku"], "no change requested"],
    [["duitku", "--enabled", "--disabled"], "enabled and disabled"],
    [["duitku", "--disabled", "--default"], "default on a disabled gateway"],
    [["duitku", "--enabled", "--bogus"], "unknown flag"],
    [["duitku", "--enabled", "--actor"], "actor without a value"],
    [["duitku", "--enabled", "--actor", "not-an-email"], "bad actor"],
  ])("rejects %j (%s)", (argv) => {
    expect(() => parseGatewaySetArgs(argv as string[])).toThrow();
  });
});

describe("setPlatformGatewayFromCli", () => {
  it("enables duitku as the default and writes the audit row as system:cli", async () => {
    const result = await run("duitku", "--enabled", "--default");
    expect(result).toMatchObject({
      provider: "duitku",
      enabled: true,
      isDefault: true,
      updatedBy: "system:cli",
    });
    // The old default loses the flag but both stay enabled (both are used).
    expect(await state()).toEqual([
      { provider: "doit", enabled: true, is_default: false },
      { provider: "duitku", enabled: true, is_default: true },
    ]);
    const rows = await changes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "duitku",
      actor_user_id: "system:cli",
      before: { enabled: false, isDefault: false },
      after: { enabled: true, isDefault: true },
    });
    expect(rows[0].reason).toContain("gateway:set");
  });

  it("records the operator email passed as the actor", async () => {
    await run("duitku", "--enabled", "--actor", "ops-a@example.com");
    expect((await changes())[0]).toMatchObject({
      actor_user_id: "ops-a@example.com",
    });
  });

  it("makes an already enabled gateway the default without --enabled", async () => {
    await run("duitku", "--enabled");
    await run("duitku", "--default");
    expect(await state()).toEqual([
      { provider: "doit", enabled: true, is_default: false },
      { provider: "duitku", enabled: true, is_default: true },
    ]);
  });

  it("keeps webhook window and secret grace when only flags change", async () => {
    await owner.query(
      "UPDATE platform_payment_gateways SET webhook_tolerance_past_sec = 7200, secret_grace_hours = 24 WHERE provider = 'duitku'",
    );
    resetPlatformGatewayCache();
    await run("duitku", "--enabled");
    const duitku = (await listPlatformGateways()).find(
      (row) => row.provider === "duitku",
    );
    expect(duitku).toMatchObject({
      webhookTolerancePastSec: 7200,
      secretGraceHours: 24,
    });
  });

  it("disables a non-default gateway while another stays active", async () => {
    await run("duitku", "--enabled");
    await run("duitku", "--disabled");
    expect(await state()).toEqual([
      { provider: "doit", enabled: true, is_default: true },
      { provider: "duitku", enabled: false, is_default: false },
    ]);
    expect(await changes()).toHaveLength(2);
  });

  it("rejects default on a disabled gateway and changes nothing", async () => {
    await expect(run("duitku", "--default")).rejects.toThrow(/enabled/i);
    expect(await state()).toEqual([
      { provider: "doit", enabled: true, is_default: true },
      { provider: "duitku", enabled: false, is_default: false },
    ]);
    expect(await changes()).toHaveLength(0);
  });

  it("rejects disabling the only active gateway and changes nothing", async () => {
    // The default is also protected on its own.
    await expect(run("doit", "--disabled")).rejects.toMatchObject({
      code: "GATEWAY_IS_DEFAULT",
    });
    // No default set (direct SQL state): the last-active guard answers.
    await owner.query(
      "UPDATE platform_payment_gateways SET is_default = false",
    );
    resetPlatformGatewayCache();
    await expect(run("doit", "--disabled")).rejects.toMatchObject({
      code: "GATEWAY_LAST_ACTIVE",
    });
    expect(
      (await state()).find((row) => row.provider === "doit"),
    ).toMatchObject({ enabled: true });
    expect(await changes()).toHaveLength(0);
  });

  it("does not overwrite a webhook window changed after the CLI's last read", async () => {
    await listPlatformGateways(); // warm the process cache (stale from here)
    await owner.query(
      "UPDATE platform_payment_gateways SET webhook_tolerance_past_sec = 4000, webhook_tolerance_future_sec = 120, secret_grace_hours = 12 WHERE provider = 'duitku'",
    );
    await run("duitku", "--enabled");
    const { rows } = await owner.query(
      "SELECT webhook_tolerance_past_sec AS p, webhook_tolerance_future_sec AS f, secret_grace_hours AS g FROM platform_payment_gateways WHERE provider = 'duitku'",
    );
    expect(rows[0]).toEqual({ p: 4000, f: 120, g: 12 });
    const [row] = await changes();
    expect(row.before).toMatchObject({
      webhookTolerancePastSec: 4000,
      webhookToleranceFutureSec: 120,
      secretGraceHours: 12,
      enabled: false,
    });
    // Only the flagged field differs in the audit row.
    const differing = Object.keys(row.after).filter(
      (key) => row.after[key] !== row.before[key],
    );
    expect(differing).toEqual(["enabled"]);
  });

  it("does not re-enable a gateway disabled after the CLI's last read", async () => {
    await run("duitku", "--enabled");
    await listPlatformGateways(); // warm the cache: duitku looks enabled
    await owner.query(
      "UPDATE platform_payment_gateways SET enabled = false WHERE provider = 'duitku'",
    );
    await expect(run("duitku", "--default")).rejects.toThrow(/enabled/i);
    expect(
      (await state()).find((row) => row.provider === "duitku"),
    ).toMatchObject({ enabled: false, is_default: false });
  });

  it("rejects disabling the default while another gateway is active", async () => {
    await run("duitku", "--enabled");
    await expect(run("doit", "--disabled")).rejects.toMatchObject({
      code: "GATEWAY_IS_DEFAULT",
    });
    expect(
      (await state()).find((row) => row.provider === "doit"),
    ).toMatchObject({ enabled: true, is_default: true });
  });

  it("rejects enabling a gateway that has no adapter in this process", async () => {
    resetPaymentGateways();
    registerPaymentGateway(port("doit"));
    await expect(run("duitku", "--enabled")).rejects.toMatchObject({
      code: "GATEWAY_NOT_REGISTERED",
    });
    expect(await changes()).toHaveLength(0);
  });
});
