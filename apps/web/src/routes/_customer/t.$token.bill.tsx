import { createFileRoute } from "@tanstack/react-router";
import { BillPage } from "@/features/ws03-qr-order/components/bill/bill-page";

// "/t/[token]/bill": session bill, split bill, pay my share, claim points
// (bead legend-woz). Rendered inside the t.$token layout.
export const Route = createFileRoute("/_customer/t/$token/bill")({
  component: BillPage,
});
