// Page-level guards for the order detail and charge screens. Presentation only:
// the API re-checks every request (the charge collect route needs
// `pos.payment.accept`). Same pattern as ../ws04-pos-kasir/guard.ts.
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

/** Reading one order and starting a POS void from it. */
export const orderDetailGuard = () =>
  posPageGuard(["pos.sale.create", "pos.payment.accept", "pos.void.request"]);

/** Taking the cash of a swap difference: the POS tender permission. */
export const chargeCollectGuard = () => posPageGuard(["pos.payment.accept"]);
