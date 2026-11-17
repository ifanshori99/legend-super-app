// Test helper (legend-oark): runs `run` as an edge process (static EDGE_MODE
// setting on), then restores the previous value. applyStaffPinRecords refuses
// to run anywhere else.
//
// legend-91u09: a real edge always has a node identity and a loaded device
// registry. A test that registers its edge node with `setEdgeNodeForEnvTests`
// gets both installed for the duration of each `withEdgeModeEnv` run (device
// credentials are refused on an edge process without an identity).
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { randomUUID } from "node:crypto";
import {
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";

let node: { readonly tenantId: string; readonly outletId: string } | null =
  null;
let depth = 0;
let saved: ReturnType<typeof getEdgeRuntimeState> | null = null;

/** The edge node (tenant + outlet) that `withEdgeModeEnv` runs as; null clears. */
export function setEdgeNodeForEnvTests(
  next: { readonly tenantId: string; readonly outletId: string } | null,
): void {
  node = next;
}

/**
 * Install `next` as this process's edge node (identity plus a loaded device
 * registry) until `removeEdgeNodeForTests`. For files whose whole process runs
 * with EDGE_MODE on, so `withEdgeModeEnv` is never used.
 */
export function installEdgeNodeForTests(next: {
  readonly tenantId: string;
  readonly outletId: string;
}): void {
  installNodeState(next);
}

export function removeEdgeNodeForTests(): void {
  setEdgeRuntimeStateForTests(cloudRuntime);
  setDeviceRegistryReadyForTests(null);
}

const cloudRuntime = getEdgeRuntimeState();

function installNode(): void {
  if (node) installNodeState(node);
}

function installNodeState(node: {
  readonly tenantId: string;
  readonly outletId: string;
}): void {
  const outletId = outletIdSchema.parse(node.outletId);
  const tenant = establishTenantContext({
    tenantId: node.tenantId,
    brandId: null,
    source: "session",
  });
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: establishScopedTenantContext(tenant, {
        kind: "outlets",
        outletIds: [outletId],
      }),
      scope: {
        tenantId: node.tenantId,
        outletId,
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

export async function withEdgeModeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  if (depth++ === 0 && node) {
    saved = getEdgeRuntimeState();
    installNode();
  }
  try {
    return await run();
  } finally {
    if (--depth === 0 && saved) {
      setEdgeRuntimeStateForTests(saved);
      setDeviceRegistryReadyForTests(null);
      saved = null;
    }
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}
