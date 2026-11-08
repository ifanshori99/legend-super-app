// Page-level guards for the POS cashier screens (PRD v1.7 §3 F8 "Shift & Tutup
// Hari", §3 F11 "POS Kasir"): the ops area already requires an operations
// permission; each screen additionally needs its own. Presentation only, the
// API re-checks every request.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

function posPageGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/** Taking payment and the "Bayar di kasir" code lookup. */
export const cashierPaymentGuard = () =>
  posPageGuard(["pos.sale.create", "pos.payment.accept"]);

/** The cashier's own shift: open, cash movements, blind count. */
export const cashierShiftGuard = () =>
  posPageGuard(["pos.sale.create", "shift.cash.operate"]);

/** Supervisor shift approval and the outlet manager's day close. */
export const shiftApprovalGuard = () =>
  posPageGuard(["shift.cash.approve_close"]);
