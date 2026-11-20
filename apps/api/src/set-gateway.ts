// Switches a platform payment gateway on or off and picks the default:
// pnpm --filter @starter/api gateway:set <doit|duitku> [--enabled|--disabled] [--default]
// Same writer and change history as the Super Admin API (legend-0orff).
import "./load-env";
import { env } from "./config/env";
import { pool } from "./db";
import { createDoitGateway } from "./services/payment-doit";
import { createDuitkuGateway } from "./services/payment-duitku";
import { registerPaymentGateway } from "./services/payment-gateway";
import {
  GATEWAY_SET_USAGE,
  parseGatewaySetArgs,
  setPlatformGatewayFromCli,
} from "./services/platform-gateway-cli";
import { HttpError } from "./lib/http-error";

try {
  const args = parseGatewaySetArgs(process.argv.slice(2));
  // The writer only enables a gateway that has an adapter in this process:
  // register them as server.ts does (Duitku needs its callback settings).
  registerPaymentGateway(createDoitGateway());
  if (env.DUITKU_CALLBACK_BASE_URL && env.DUITKU_RETURN_URL)
    registerPaymentGateway(
      createDuitkuGateway({
        callbackBaseUrl: env.DUITKU_CALLBACK_BASE_URL,
        returnUrl: env.DUITKU_RETURN_URL,
      }),
    );
  const row = await setPlatformGatewayFromCli(args);
  console.log(
    `${row.provider}: ${row.enabled ? "enabled" : "disabled"}${row.isDefault ? ", default" : ""} (by ${row.updatedBy})`,
  );
} catch (error) {
  if (error instanceof HttpError) {
    console.error(error.message);
    if (error.code === "VALIDATION_ERROR") console.error(GATEWAY_SET_USAGE);
  } else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
