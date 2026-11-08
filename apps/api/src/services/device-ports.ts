// Wires the device registry into the edge ports (bead legend-165). The edge
// status route (`/api/edge/status`, `thisDevice`) asks the EdgeDeviceLookup
// port whether a device token names a registered device of this outlet; until
// this is installed the port answers null (fail closed). The lookup reads the
// local `devices` table: on an edge node that is the replica, on the cloud the
// registry itself.
import type { ScopedTenantContext } from "@starter/shared/core";
import type { Device } from "@starter/shared/edge";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";
import { setEdgeDeviceLookup } from "../edge/ports.ts";
import { toDevice } from "./device.service.ts";

/** One registry row of the context's tenant, any status, or null. */
export async function lookupRegisteredDevice(
  context: ScopedTenantContext,
  deviceId: string,
): Promise<Device | null> {
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.id, deviceId),
        ),
      )
      .limit(1),
  );
  return row ? toDevice(row) : null;
}

let installed = false;

/** Installs the registry-backed EdgeDeviceLookup once; safe to call again. */
export function installDeviceRegistryPorts(): void {
  if (installed) return;
  setEdgeDeviceLookup(lookupRegisteredDevice);
  installed = true;
}
