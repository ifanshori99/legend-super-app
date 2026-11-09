// Optional live smoke test against the DOIT sandbox (bead legend-b9i; the full
// certification is legend-s5c). Skipped unless DOIT_API_KEY is set in the
// command's environment and is a sandbox key (pb_test_…), so `pnpm check` and
// CI never call DOIT and a live key is never used:
//
//   DOIT_API_KEY="$(cat ~/.config/legend/doit-sandbox-api-key)" \
//   pnpm --filter <api package> exec vitest run src/test/payment-doit-sandbox.test.ts
//
// DOIT has one host (https://pay.doit.id) for sandbox and live; the key prefix
// picks the environment. DOIT_BASE_URL overrides the host only for a local
// fake.
//
// Read-only: it lists the active methods (GET /v1/methods) and checks health.
// It never creates a payment. The key is never printed: no assertion message,
// log line or snapshot carries it, and the test fails if the adapter's error
// text does.

import { promises as dns } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createDoitGateway } from "../services/payment-doit";

const apiKey = process.env.DOIT_API_KEY ?? "";
const baseUrl = process.env.DOIT_BASE_URL || undefined;
const enabled = apiKey.startsWith("pb_test_");

const TENANT_ID = "7a1e2d3c-4b5a-4968-8776-655443322110";
const INTEGRATION_ID = "5b0b3f7e-2f4a-4c0e-9a55-5d3c1a7e9f01";

describe.skipIf(!enabled)("DOIT sandbox smoke (optional, read-only)", () => {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: TENANT_ID,
      brandId: null,
      source: "webhook",
    }),
    { kind: "tenant" },
  );
  const gateway = createDoitGateway({
    // Exercise the real DNS rebinding guard, which tests skip by default.
    lookup: (host) => dns.lookup(host, { all: true }),
    loadCredentials: async () => ({
      integration: {
        id: INTEGRATION_ID,
        outletId: null,
        config: baseUrl ? { baseUrl } : {},
      },
      // The webhook secret is not needed for read-only calls.
      credentials: { apiKey, webhookSecret: "unused-in-smoke-test" },
    }),
  });

  it("lists active methods from the DOIT endpoint", async () => {
    let methods;
    try {
      methods = await gateway.methods?.(context);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // Fail without echoing anything that could carry the key.
      expect(text.includes(apiKey), "error text leaked the key").toBe(false);
      throw new Error(
        "DOIT sandbox call failed; check the key and the wire format",
      );
    }
    expect(Array.isArray(methods)).toBe(true);
    expect(JSON.stringify(methods).includes(apiKey)).toBe(false);
  }, 20_000);

  it("reports the gateway as available", async () => {
    const health = await gateway.health(context);
    expect(health.status).toBe("available");
  }, 20_000);
});
