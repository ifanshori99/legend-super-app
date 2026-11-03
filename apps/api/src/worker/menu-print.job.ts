// Worker job for the printable menu (bead legend-dmi). Two pieces, both
// registered by the lead (this file does not touch the worker registry):
//  1. `menuPrintOutboxDeliver`: the `deliver` callback for a `consumeOutbox`
//     consumer on menu events; it only marks outlets dirty (debounced).
//  2. `runMenuPrintSweepJob`: periodic sweep (e.g. pg-boss schedule every
//     30 s) that renders each due outlet once.

import type { ScopedTenantContext } from "@starter/shared/core";
import {
  createMenuPrintDirtyConsumer,
  runDueMenuPrints,
  type MenuPrintDeps,
} from "../services/menu-print.service.ts";

export const MENU_PRINT_SWEEP_QUEUE = "menu-print-sweep";
export const MENU_PRINT_SWEEP_INTERVAL_SECONDS = 30;

export const menuPrintOutboxDeliver = createMenuPrintDirtyConsumer();

/** `contexts` must be trusted tenant-scope contexts from the tenant registry. */
export async function runMenuPrintSweepJob(
  contexts: readonly ScopedTenantContext[],
  deps: MenuPrintDeps,
  now = new Date(),
): Promise<{ regenerated: number; failed: number }> {
  let regenerated = 0;
  let failed = 0;
  for (const context of contexts) {
    // One tenant's failure (DB error, bad context) must not stop the sweep for
    // the others; a missing renderer already comes back as `failed` outlets.
    try {
      const result = await runDueMenuPrints(context, deps, now);
      regenerated += result.regenerated.length;
      failed += result.failed.length;
    } catch {
      failed += 1;
    }
  }
  return { regenerated, failed };
}
