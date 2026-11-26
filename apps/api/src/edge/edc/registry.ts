// Bank adapter registry for the EDC agent (bead legend-apt). One EdcProvider
// per bank. The agent resolves the terminal's bank_code here BEFORE it writes
// any ledger row, so an unsupported bank never leaves a pending transaction.
import { EdcError } from "@starter/shared/edc";
import type { EdcBank, EdcProvider } from "@starter/shared/edc";
import { EcrSimulator } from "./simulator.ts";

const allBanks = [
  "bca",
  "mandiri",
  "bni",
  "bjb",
  "bri",
] as const satisfies readonly EdcBank[];

export class EdcProviderRegistry {
  readonly #providers = new Map<string, EdcProvider>();

  register(provider: EdcProvider): this {
    if (this.#providers.has(provider.bank))
      throw new Error(`EDC provider already registered for ${provider.bank}`);
    this.#providers.set(provider.bank, provider);
    return this;
  }

  /** `bank` comes from a database row or a request: never trusted. */
  get(bank: string): EdcProvider {
    const provider = this.#providers.get(bank);
    if (!provider) throw new EdcError("EDC_PROVIDER_UNKNOWN");
    return provider;
  }

  banks(): EdcBank[] {
    return [...this.#providers.keys()] as EdcBank[];
  }
}

/** Simulators only in dev/test/demo. Production gets an empty registry until
 * the bank adapters (bead legend-vpx) are registered at boot. A simulator in
 * production would approve payments no bank ever saw, so it throws there.
 * `production` defaults to `NODE_ENV === "production"` (as `tlsAskGuard`). */
export function createDefaultEdcRegistry(options: {
  simulator: boolean;
  production?: boolean;
}): EdcProviderRegistry {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  if (options.simulator && production)
    throw new Error("EDC simulators are not allowed in production");
  const registry = new EdcProviderRegistry();
  if (options.simulator)
    for (const bank of allBanks) registry.register(new EcrSimulator(bank));
  return registry;
}
