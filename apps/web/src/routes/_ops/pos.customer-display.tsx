import { createFileRoute } from "@tanstack/react-router";
import { CustomerDisplayScreen } from "@/features/ws04-display/components/customer-display-screen";

// /pos/customer-display — the paired second screen at the cashier: items,
// total and dynamic QRIS for the customer (PRD §3 F11 "Customer Display",
// §3 F13 "QRIS Dinamis"). The ops layout owns the guard, the shell and the
// Kontras Tinggi density; pairing is a terminal action, so this screen is
// read-only.
export const Route = createFileRoute("/_ops/pos/customer-display")({
  component: CustomerDisplayScreen,
});
