// 1269 C0 (legend-osqou.1): every Duitku method is locked until it is listed in
// DUITKU_ENABLED_METHODS, and a sandbox account is refused in production unless
// DUITKU_ALLOW_SANDBOX (staging) is on.
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env";
import {
  createDuitkuGateway,
  duitkuCredentialSet,
} from "../services/payment-duitku";

// Loaders are injected: keep the DB-backed store out of the import graph.
vi.mock("../services/platform-integration.service", () => ({
  loadActiveIntegrationCredentials: vi.fn(),
  loadIntegrationCredentialsById: vi.fn(),
}));

const TENANT_ID = "0b1f2c3d-0000-4000-8000-000000000001";
const INTEGRATION_ID = "0b1f2c3d-0000-4000-8000-0000000000b1";
const INTENT_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-25T03:00:00.000Z");

const context = {
  tenant: { tenantId: TENANT_ID },
  outletScope: { kind: "all", tenantId: TENANT_ID },
} as unknown as ScopedTenantContext;

const row = (environment: "sandbox" | "production") => ({
  integration: {
    id: INTEGRATION_ID,
    outletId: null,
    config: { environment, notificationEmail: "owner@example.test" },
  },
  credentials: { merchantCode: "DS1234", apiKey: "api-key-SECRET" },
});

function gateway(environment: "sandbox" | "production" = "production") {
  const urls: string[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = String(url).endsWith("getpaymentmethod")
      ? {
          responseCode: "00",
          paymentFee: ["SP", "BC", "OV", "VC"].map((paymentMethod) => ({
            paymentMethod,
            paymentName: `Method ${paymentMethod}`,
            totalFee: "0",
          })),
        }
      : String(url).endsWith("inquiry")
        ? {
            statusCode: "00",
            reference: "REF-1",
            paymentUrl: "https://passport.duitku.com/pay/REF-1",
            vaNumber: "8800123456789",
            qrString: "00020101021226QRSTRING",
            amount: String(body.paymentAmount),
          }
        : {
            merchantOrderId: body.merchantOrderId,
            statusCode: "00",
            reference: "REF-1",
            amount: "50000",
          };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  const port = createDuitkuGateway({
    fetch: fetchImpl,
    now: () => NOW,
    callbackBaseUrl: "https://api.example.test",
    returnUrl: "https://app.example.test/paid",
    loadCredentials: async () => row(environment),
    loadCredentialsById: async () => row(environment),
  });
  return { port, urls };
}

const request = (
  method: "qris" | "va" | "ewallet" | "card",
  channelCode: string | null,
) => ({
  context,
  provider: "duitku",
  intentId: INTENT_ID,
  method,
  channelCode,
  amountIdr: 50_000,
  idempotencyKey: "idem-1",
  expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
});

const CASES = [
  ["qris", null],
  ["va", "BC"],
  ["ewallet", "OV"],
  ["card", null],
] as const;

const saved = {
  methods: env.DUITKU_ENABLED_METHODS,
  allowSandbox: env.DUITKU_ALLOW_SANDBOX,
  isProduction: env.isProduction,
};
beforeEach(() => {
  env.DUITKU_ENABLED_METHODS = [];
});
afterEach(() => {
  env.DUITKU_ENABLED_METHODS = saved.methods;
  env.DUITKU_ALLOW_SANDBOX = saved.allowSandbox;
  env.isProduction = saved.isProduction;
});

describe("duitku method lock", () => {
  it("locks every method by default: none listed, no channel", async () => {
    const { port } = gateway();
    const listed = await port.methods!(context);
    expect(listed.map((entry) => entry.enabled)).toEqual(
      listed.map(() => false),
    );
    expect(listed.flatMap((entry) => entry.channels)).toEqual([]);
    expect(await port.methods!(context, undefined, 50_000)).toEqual(listed);
    expect(await port.channels(context, "va")).toEqual([]);
    expect(await port.channels(context, "ewallet")).toEqual([]);
  });

  it.each(CASES)(
    "refuses a locked %s intent before any provider call",
    async (method, channelCode) => {
      const { port, urls } = gateway();
      await expect(
        port.createIntent(request(method, channelCode)),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(urls).toEqual([]);
    },
  );

  it.each(CASES)(
    "listing only %s opens it and nothing else",
    async (method, channelCode) => {
      env.DUITKU_ENABLED_METHODS = [method];
      const { port } = gateway();
      const listed = await port.methods!(context);
      expect(
        listed.filter((entry) => entry.enabled).map((entry) => entry.method),
      ).toEqual([method]);
      for (const other of ["va", "ewallet"] as const)
        expect((await port.channels(context, other)).length).toBe(
          other === method ? 1 : 0,
        );
      const intent = await port.createIntent(request(method, channelCode));
      expect(intent.providerRef).toBe("REF-1");
      for (const [other, code] of CASES)
        if (other !== method)
          await expect(
            port.createIntent(request(other, code)),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    },
  );

  it("still reads the status of a code already out while locked", async () => {
    const { port } = gateway();
    expect(
      await port.getStatus({
        context,
        integrationId: INTEGRATION_ID,
        providerRef: "REF-1",
        intentId: INTENT_ID,
      }),
    ).toMatchObject({ status: "paid", amountIdr: 50_000 });
  });
});

describe("duitku sandbox in production", () => {
  beforeEach(() => {
    env.DUITKU_ENABLED_METHODS = ["qris", "va", "ewallet", "card"];
    env.isProduction = true;
    env.DUITKU_ALLOW_SANDBOX = false;
  });

  it("has no usable credentials, so no callback can be verified", () => {
    expect(duitkuCredentialSet(row("sandbox"), NOW)).toEqual([]);
    expect(duitkuCredentialSet(row("production"), NOW)).toHaveLength(1);
  });

  it("is unconfigured: no intent, no status, no provider call", async () => {
    const { port, urls } = gateway("sandbox");
    expect(await port.health(context)).toEqual({
      status: "down",
      reason: "unconfigured",
    });
    await expect(
      port.createIntent(request("qris", null)),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    // A sandbox "paid" is not money: it never settles a production bill.
    await expect(
      port.getStatus({
        context,
        integrationId: INTEGRATION_ID,
        providerRef: "REF-1",
        intentId: INTENT_ID,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(urls).toEqual([]);
  });

  it("is allowed with DUITKU_ALLOW_SANDBOX and outside production", () => {
    env.DUITKU_ALLOW_SANDBOX = true;
    expect(duitkuCredentialSet(row("sandbox"), NOW)).toHaveLength(1);
    env.DUITKU_ALLOW_SANDBOX = false;
    env.isProduction = false;
    expect(duitkuCredentialSet(row("sandbox"), NOW)).toHaveLength(1);
  });
});

describe("duitku env", () => {
  // config/env.ts validates process.env once, at import: a fresh process each.
  function load(
    overrides: Record<string, string | undefined>,
    preload: string[] = [],
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    for (const [key, value] of Object.entries(overrides))
      if (value === undefined) delete childEnv[key];
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        ...preload.flatMap((file) => ["--import", file]),
        "--input-type=module",
        "-e",
        `const { env } = await import("./src/config/env.ts");
         console.log(JSON.stringify([env.DUITKU_ENABLED_METHODS, env.DUITKU_ALLOW_SANDBOX]));`,
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: childEnv,
        encoding: "utf8",
      },
    );
  }

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("locks everything when %s", (_name, value) => {
    const result = load({
      DUITKU_ENABLED_METHODS: value,
      DUITKU_ALLOW_SANDBOX: undefined,
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([[], false]);
  });

  it("reads a comma-separated list and the staging switch", () => {
    const result = load({
      DUITKU_ENABLED_METHODS: "qris, va",
      DUITKU_ALLOW_SANDBOX: "true",
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([["qris", "va"], true]);
  });

  it.each(["qris,kartu", "bank_transfer", "QRIS"])(
    "refuses to start on an unknown method (%s)",
    (value) => {
      const result = load({ DUITKU_ENABLED_METHODS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("DUITKU_ENABLED_METHODS");
    },
  );

  // CTO 25 Nov: the staging switch never reaches a live or real-data process.
  // The worker loads the same module after its role marker (env.test.ts).
  describe.each([
    ["api", []],
    ["worker", ["./src/role-worker.ts"]],
  ])("DUITKU_ALLOW_SANDBOX in the %s", (_role, preload) => {
    const deployed = (overrides: Record<string, string>) =>
      load(
        {
          NODE_ENV: "production",
          EDGE_MODE: "false",
          DATABASE_URL: "postgresql://owner:pw@localhost:5432/legend",
          APP_DATABASE_URL:
            "postgresql://legend_runtime_0123456789abcdef:pw@localhost:5432/legend",
          WORKER_DATABASE_URL:
            "postgresql://legend_worker_0123456789abcdef:pw@localhost:5432/legend",
          PAYOUT_GRANTOR_DATABASE_URL:
            "postgresql://legend_grant_0123456789abcdef:pw@localhost:5432/legend",
          BETTER_AUTH_SECRET: "a".repeat(40),
          STAFF_PIN_PEPPER: "b".repeat(40),
          ...overrides,
        },
        preload,
      );

    it.each([
      ["production", "synthetic", "true"],
      ["production", "real", "true"],
      ["production", "real", "1"],
      // Already refused by the data policy; the switch is named as well.
      ["staging", "real", "true"],
    ])("stops the start: %s, %s data, %s", (mode, data, value) => {
      const result = deployed({
        DEPLOYMENT_MODE: mode,
        DATA_CLASSIFICATION: data,
        DUITKU_ALLOW_SANDBOX: value,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("DUITKU_ALLOW_SANDBOX");
      expect(result.stderr).not.toContain("postgresql://");
    });

    it.each([
      ["staging", "synthetic", "true", true],
      ["production", "real", "false", false],
    ])("lets %s with %s data start on %s", (mode, data, value, allowed) => {
      const result = deployed({
        DEPLOYMENT_MODE: mode,
        DATA_CLASSIFICATION: data,
        DUITKU_ALLOW_SANDBOX: value,
      });
      expect(result.stderr).not.toContain("DUITKU_ALLOW_SANDBOX");
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)[1]).toBe(allowed);
    });
  });
});
