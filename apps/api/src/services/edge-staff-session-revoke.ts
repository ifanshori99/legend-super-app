// Ending `edge_staff_pin` sessions (E2, brief 1269). Kept apart from the login
// service so the services that must end them (device pull, PIN reset) import it
// without a cycle. Every function runs on the CALLER's open transaction.
import { and, eq } from "drizzle-orm";
import { session } from "../db/schema/session.ts";
import { EDGE_STAFF_PIN } from "../lib/request-context.ts";
import type { Tx } from "./permission-resolver.ts";

/** Every edge session of one device (revoked device, next login on it). */
export async function endEdgeStaffSessionsOfDevice(
  tx: Tx,
  deviceId: string,
): Promise<void> {
  await tx
    .delete(session)
    .where(
      and(
        eq(session.authMethod, EDGE_STAFF_PIN),
        eq(session.edgeDeviceId, deviceId),
      ),
    );
}

/** Every edge session of one staff member of a tenant (PIN reset, inactive). */
export async function endEdgeStaffSessionsOfUser(
  tx: Tx,
  input: { readonly tenantId: string; readonly userId: string },
): Promise<void> {
  await tx
    .delete(session)
    .where(
      and(
        eq(session.authMethod, EDGE_STAFF_PIN),
        eq(session.tenantId, input.tenantId),
        eq(session.userId, input.userId),
      ),
    );
}
