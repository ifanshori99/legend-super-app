// Operator CLI for the platform payment gateway registry (legend-0orff 0O-1):
// `pnpm --filter @starter/api gateway:set <provider> [--enabled|--disabled]
// [--default] [--actor <email>]`. It reads the current row, merges the flags
// and calls `updatePlatformGateway`, the same writer as the Super Admin API,
// so the guards and the `platform_payment_gateway_changes` row are identical.
// Webhook window and secret grace are kept as they are.

import {
  paymentGatewayProviderSchema,
  type PaymentGatewayProvider,
  type PlatformGateway,
} from "@starter/shared/platform";
import { HttpError } from "../lib/http-error";
import { updatePlatformGateway } from "./platform-payment-gateway.service";

export const GATEWAY_SET_USAGE =
  "Usage: pnpm --filter @starter/api gateway:set <doit|duitku> [--enabled|--disabled] [--default] [--actor <operator email>]\n" +
  "  --default needs an enabled gateway (add --enabled to enable it in the same call).\n" +
  "  The last active gateway cannot be disabled. Audit actor defaults to system:cli.";

export const CLI_ACTOR = "system:cli";

export type GatewaySetArgs = {
  provider: PaymentGatewayProvider;
  enabled: boolean | null;
  makeDefault: boolean;
  actor: string;
};

function usage(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

export function parseGatewaySetArgs(argv: readonly string[]): GatewaySetArgs {
  // pnpm forwards a literal "--" when called as `pnpm ... gateway:set -- ...`.
  const args = argv.filter((arg) => arg !== "--");
  let provider: string | undefined;
  let enabled: boolean | null = null;
  let makeDefault = false;
  let actor = CLI_ACTOR;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--enabled" || arg === "--disabled") {
      const next = arg === "--enabled";
      if (enabled !== null && enabled !== next)
        throw usage("Use either --enabled or --disabled, not both.");
      enabled = next;
    } else if (arg === "--default") makeDefault = true;
    else if (arg === "--actor") {
      const value = args[(i += 1)];
      if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        throw usage("--actor needs the operator's email address.");
      actor = value;
    } else if (arg.startsWith("--")) throw usage(`Unknown option ${arg}.`);
    else if (provider === undefined) provider = arg;
    else throw usage(`Unexpected argument ${arg}.`);
  }
  const parsed = paymentGatewayProviderSchema.safeParse(provider);
  if (!parsed.success) throw usage("Name the gateway: doit or duitku.");
  if (enabled === null && !makeDefault)
    throw usage("Nothing to change: pass --enabled, --disabled or --default.");
  if (makeDefault && enabled === false)
    throw usage("The default gateway must be enabled.");
  return { provider: parsed.data, enabled, makeDefault, actor };
}

/**
 * Sends only the fields named by the flags to the shared writer, which merges
 * them onto the row it locks (webhook window and secret grace stay as they
 * are) and enforces the guards: default needs an enabled gateway, the last
 * active gateway and the current default cannot be disabled.
 */
export async function setPlatformGatewayFromCli(
  args: GatewaySetArgs,
): Promise<PlatformGateway> {
  return updatePlatformGateway(
    args.provider,
    {
      ...(args.enabled === null ? {} : { enabled: args.enabled }),
      // Unsetting the default alone is not offered: pick a new default.
      ...(args.makeDefault ? { isDefault: true } : {}),
      reason: "CLI gateway:set",
    },
    args.actor,
  );
}
