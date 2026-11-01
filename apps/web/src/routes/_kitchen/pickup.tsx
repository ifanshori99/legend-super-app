import { createFileRoute } from "@tanstack/react-router";
import { PickupScreen } from "@/features/ws04-expo/components/pickup-screen";

// /pickup — kitchen area (PRD §5 "Peta situs": /kds/*, /expo, /pickup). Serves
// the wall display and the staff tablet (bead legend-zvz).
export const Route = createFileRoute("/_kitchen/pickup")({
  component: PickupScreen,
});
