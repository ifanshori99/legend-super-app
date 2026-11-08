import { Link } from "@tanstack/react-router";
import { Store } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import { Notice } from "../shared";
import { useActiveShift } from "../../hooks";
import { paymentReturnTo } from "../../return-to";

// Cash needs an open shift: the money goes into that shift's drawer. Blocked
// only once the shift query has answered and the shift is not open; while
// loading or on a load error the cashier is not stopped here (the server
// still decides, see `isShiftNotOpen`).
//   - "none": no shift at all, the way out is to open one.
//   - "awaiting": the shift was counted and waits for the supervisor; a new
//     shift can only be opened after that, so there is no button.
export type CashShiftGate = {
  state: "loading" | "open" | "none" | "awaiting";
  blocked: boolean;
};

export function useCashShiftGate(): CashShiftGate {
  const shift = useActiveShift();
  if (!shift.isSuccess) {
    return { state: shift.isPending ? "loading" : "open", blocked: false };
  }
  const status = shift.data?.status;
  if (status === "open") return { state: "open", blocked: false };
  return {
    state: status === "awaiting_approval" ? "awaiting" : "none",
    blocked: true,
  };
}

// The server refused a cash payment because no shift is open (409).
export function isShiftNotOpen(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "SHIFT_NOT_OPEN"
  );
}

// Cash is blocked: either "Belum ada shift kasir terbuka" with the way out
// (open a shift, see `OpenShiftButton`), or "Shift sedang menunggu persetujuan" with no action. Other
// payment methods stay usable, so the notice never replaces the method choice.
// After the shift is opened the cashier comes back to this bill. The notice is
// a status region with an id so the disabled buttons can point at it.
export const CASH_SHIFT_NOTICE_ID = "pos-cash-shift-notice";

export function CashShiftNotice({ awaiting }: { awaiting: boolean }) {
  const t = useT();
  if (awaiting) {
    return (
      <Notice
        id={CASH_SHIFT_NOTICE_ID}
        role="status"
        tone="warning"
        title={t("posKasirPayment.awaitingShift.title")}
      >
        <p>{t("posKasirPayment.awaitingShift.hint")}</p>
      </Notice>
    );
  }
  return (
    <Notice
      id={CASH_SHIFT_NOTICE_ID}
      role="status"
      tone="warning"
      title={t("posKasirPayment.noShift.title")}
    >
      <p>{t("posKasirPayment.noShift.hint")}</p>
    </Notice>
  );
}

// The way out when there is no shift. It takes the place of the footer's main
// action (continue with cash, confirm cash), so it is always in view instead
// of below the fold inside the notice.
export function OpenShiftButton({ orderId }: { orderId: string }) {
  const t = useT();
  return (
    <Button asChild aria-describedby={CASH_SHIFT_NOTICE_ID}>
      <Link to="/pos/shift" search={{ returnTo: paymentReturnTo(orderId) }}>
        <Store aria-hidden="true" />
        {t("posKasirPayment.noShift.action")}
      </Link>
    </Button>
  );
}
