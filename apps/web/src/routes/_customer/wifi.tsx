import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { WifiPortal } from "@/features/ws09-wifi/components/wifi-portal";

// "/wifi" — guest Wi-Fi captive portal (PRD v1.7 §5: served by the edge node,
// no-store, noindex via the customer area). The QR at the table or the Wi-Fi
// sticker carries the zone; a table QR also carries its session token so the
// "+1 jam" action can open the drinks menu without a second scan (Alur X).
const searchSchema = z.object({
  zone: z.uuid().optional().catch(undefined),
  facility: z.uuid().optional().catch(undefined),
  table: z.string().min(1).max(200).optional().catch(undefined),
});

export const Route = createFileRoute("/_customer/wifi")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: WifiRoute,
});

function WifiRoute() {
  const search = Route.useSearch();
  const { access } = Route.useRouteContext();
  return (
    <WifiPortal
      zoneId={search.zone}
      facilityId={search.facility}
      tableToken={search.table}
      signedIn={access.authenticated}
    />
  );
}
