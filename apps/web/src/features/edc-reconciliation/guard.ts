// Page guard for EDC reconciliation (legend-khi8n): the kelola area already
// requires dashboard.management.view + MFA; this page additionally needs
// payment.reconcile. The API re-checks it on every request (docs/frontend.md
// "Page guard"), so this only hides a screen the caller could not use.
import type { PermissionCode } from "@starter/shared/access";
import { paymentAdminGuard } from "../ws05-payment-admin/guard";

export const EDC_RECONCILE_PERMISSIONS: readonly PermissionCode[] = [
  "payment.reconcile",
];

export const edcReconciliationGuard = paymentAdminGuard(
  EDC_RECONCILE_PERMISSIONS,
);
