// Wi-Fi provider selection for the edge runtime (bead legend-hsk). Simulator in
// dev/test/demo only. Production gets no provider (null) until the vendor
// adapter (dpc) is registered at boot: the agent then stays off and the port
// answers 503. A simulator in production would grant access no controller ever
// saw, so it throws there (same rule as `createDefaultEdcRegistry`).
import type { WifiProvider } from "@starter/shared/adapters";
import { WifiControllerSimulator } from "./simulator.ts";

/** `production` defaults to `NODE_ENV === "production"`. */
export function createDefaultWifiProvider(options: {
  simulator: boolean;
  production?: boolean;
}): WifiProvider | null {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  if (options.simulator && production)
    throw new Error("Wi-Fi simulator is not allowed in production");
  return options.simulator ? new WifiControllerSimulator() : null;
}
