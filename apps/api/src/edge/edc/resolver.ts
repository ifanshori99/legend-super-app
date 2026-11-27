// Which EDC agent serves an outlet's ECR sale in this process (B2
// legend-wasr7.21). The edge node's own agent first (frozen path, legend-kwy6d:
// set only in EDGE_MODE on the primary); otherwise the cloud agent, only while
// this process owns the outlet (cloud-runtime.ts). Null = `EDC_AGENT_NOT_READY`
// before anything is written: never forwarded to another process.
import type { OutletId, TenantId } from "@starter/shared/core";
import type { paymentEdcTerminals } from "../../db/schema/index.ts";
import type { EdcAgent } from "./agent.ts";
import { getCloudEdcRuntime } from "./cloud-runtime.ts";
import { getEdgeEdcAgent } from "./runtime.ts";

export type ResolvedEdcAgent = {
  readonly agent: EdcAgent;
  /** Presentation only: would an ECR sale on this terminal reach it now?
   * The edge agent answers per bank (`canSell`). */
  terminalReady(row: typeof paymentEdcTerminals.$inferSelect): boolean;
};

/** Before resolving for a sale (or its payment options): lets the cloud take
 * a cloud-provider outlet lazily (`prepareSale`). No-op on the edge. */
export async function prepareEdcAgent(
  tenantId: TenantId,
  outletId: OutletId,
): Promise<void> {
  if (getEdgeEdcAgent()) return;
  await getCloudEdcRuntime()?.prepareSale(tenantId, outletId);
}

export function resolveEdcAgent(
  tenantId: TenantId,
  outletId: OutletId,
): ResolvedEdcAgent | null {
  const edge = getEdgeEdcAgent();
  if (edge)
    return {
      agent: edge,
      terminalReady: (row) => edge.canSell(tenantId, outletId, row.bankCode),
    };
  const cloud = getCloudEdcRuntime();
  const agent = cloud?.agentFor(tenantId, outletId) ?? null;
  if (!cloud || !agent) return null;
  return {
    agent,
    terminalReady: (row) =>
      agent.canSell(tenantId, outletId, row.bankCode) &&
      cloud.terminalReady(row),
  };
}
