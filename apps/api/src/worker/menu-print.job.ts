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
  shouldStop: () => boolean = () => false,
  onTenantError?: (tenantId: string) => void,
): Promise<{ regenerated: number; failed: number }> {
  let regenerated = 0;
  let failed = 0;
  for (const context of contexts) {
    if (shouldStop()) break;
    // One tenant's failure (DB error, bad context) must not stop the sweep for
    // the others; a missing renderer already comes back as `failed` outlets.
    try {
      const result = await runDueMenuPrints(
        context,
        deps,
        now,
        undefined,
        shouldStop,
      );
      regenerated += result.regenerated.length;
      failed += result.failed.length;
    } catch {
      failed += 1;
      onTenantError?.(context.tenant.tenantId);
    }
  }
  return { regenerated, failed };
}

/**
 * Self-scheduling sweep loop for the worker process (legend-iuvq). Rounds never
 * overlap; a tenant whose context cannot be resolved is skipped, never stops
 * the others. `stop()` waits for the round in flight, which checks the stop flag
 * between tenants and outlets. `onRound` gets each finished round's counts;
 * `onError` gets the tenant id when one tenant is to blame.
 */
export function createMenuPrintSweepLoop(options: {
  listTenantIds: () => Promise<readonly string[]>;
  resolveContext: (tenantId: string) => Promise<ScopedTenantContext>;
  deps: MenuPrintDeps;
  intervalMs?: number;
  onError?: (message: string, tenantId?: string) => void;
  onRound?: (result: { regenerated: number; failed: number }) => void;
}) {
  const intervalMs =
    options.intervalMs ?? MENU_PRINT_SWEEP_INTERVAL_SECONDS * 1000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let round: Promise<unknown> = Promise.resolve();

  async function runRound(now = new Date()) {
    const contexts: ScopedTenantContext[] = [];
    try {
      for (const id of await options.listTenantIds()) {
        if (stopped) return;
        try {
          contexts.push(await options.resolveContext(id));
        } catch {
          options.onError?.("Menu print sweep could not resolve a tenant", id);
        }
      }
      const result = await runMenuPrintSweepJob(
        contexts,
        options.deps,
        now,
        () => stopped,
        (tenantId) =>
          options.onError?.("Menu print sweep failed for a tenant", tenantId),
      );
      options.onRound?.(result);
      return result;
    } catch {
      options.onError?.("Menu print sweep failed");
    }
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      round = runRound().finally(schedule);
    }, intervalMs);
  }
  return {
    runRound,
    start: schedule,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await round;
    },
  };
}
