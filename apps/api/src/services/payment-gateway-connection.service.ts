// "Test connection" for a payment gateway integration (sub-302 D16; PAY-06).
//
// The adapter (`PaymentGatewayPort.testConnection`) does the provider call
// with the credentials of the row, draft or active. This service decides who
// may call it, stores the outcome (`last_checked_at`, `last_error_code`,
// audit) and shapes the answer. Nothing here sees, returns or logs a
// credential, a signature or a raw provider body: the adapter answers with a
// fixed error code and the method list only.

import {
  integrationCategoryOf,
  type IntegrationConnectionTest,
} from "@starter/shared/platform";
import type { ScopedTenantContext } from "@starter/shared/core";
import { HttpError } from "../lib/http-error.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
import {
  getIntegrationForCheck,
  recordConnectionCheck,
} from "./platform-integration.service.ts";

function notSupported(): HttpError {
  return new HttpError(
    422,
    "NOT_SUPPORTED",
    "This integration cannot be tested from here.",
  );
}

export async function testGatewayConnection(
  context: ScopedTenantContext,
  integrationId: string,
  actorUserId: string,
): Promise<IntegrationConnectionTest> {
  const row = await getIntegrationForCheck(context, integrationId);
  if (integrationCategoryOf[row.provider] !== "payment_gateway")
    throw notSupported();
  const adapter = paymentGatewayFor(row.provider);
  if (!adapter.testConnection) throw notSupported();

  let result: Awaited<ReturnType<NonNullable<typeof adapter.testConnection>>>;
  try {
    result = await adapter.testConnection(context, row.id);
  } catch {
    // The thrown error may carry provider text; only the fixed code leaves.
    result = { ok: false, code: "GATEWAY_UNREACHABLE" };
  }
  const errorCode = result.ok ? null : result.code;
  const { checkedAt } = await recordConnectionCheck(
    context,
    row.id,
    actorUserId,
    { ok: result.ok, errorCode },
  );
  return {
    ok: result.ok,
    checkedAt,
    errorCode,
    methods: result.ok
      ? result.methods.map((entry) => ({
          method: entry.method,
          enabled: entry.enabled,
          channelCount: entry.channels.length,
        }))
      : [],
  };
}
