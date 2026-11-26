import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OpenOrdersScreen } from "@/features/ws04-pos-open-orders/components/open-orders-screen";
import { openOrdersGuard } from "@/features/ws04-pos-open-orders/guard";

// /pos/pesanan — orders not finished yet ("Belum selesai") and parked carts
// (`?tab=ditahan`), brief 1268 W5. "Buka" goes to /pos/pesanan/$orderId.
export const Route = createFileRoute("/_ops/pos/pesanan/")({
  validateSearch: z.object({
    tab: z.enum(["ditahan"]).optional().catch(undefined),
  }),
  beforeLoad: openOrdersGuard(),
  component: OpenOrdersRoute,
});

function OpenOrdersRoute() {
  const { tab } = Route.useSearch();
  return <OpenOrdersScreen tab={tab === "ditahan" ? "parked" : "open"} />;
}
