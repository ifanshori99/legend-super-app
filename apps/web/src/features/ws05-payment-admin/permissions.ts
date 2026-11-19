// Permission codes of the payment back office. Kept apart from lib.ts so nav.ts
// (read by the shell of every area) does not pull lib.ts and its message keys
// into every area (legend-0rzwb).
import type { PermissionCode } from "@starter/shared/access";

/** Gateway routing GET/PUT need this permission (sub-302 D14), not EDC's. */
export const ROUTING_MANAGE_PERMISSION: PermissionCode = "org.settings.manage";

/** Duitku credentials PUT/test need this permission (sub-302 D15-D16). */
export const INTEGRATION_MANAGE_PERMISSION: PermissionCode =
  "org.integration.manage";

/** Permissions that may open /kelola/pembayaran (any one is enough). */
export const PAYMENT_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  "payment.transaction.view",
  "payment.reconcile",
  "payment.edc.manage",
  ROUTING_MANAGE_PERMISSION,
  INTEGRATION_MANAGE_PERMISSION,
];
