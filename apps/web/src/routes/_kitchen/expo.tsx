import { createFileRoute } from "@tanstack/react-router";
import { ExpoScreen } from "@/features/ws04-expo/components/expo-screen";

// /expo — kitchen area (PRD §5 "Peta situs": /kds/*, /expo, /pickup). The area
// layout owns the guard, the shell and the dark kitchen mode (bead legend-zvz).
export const Route = createFileRoute("/_kitchen/expo")({
  component: ExpoScreen,
});
