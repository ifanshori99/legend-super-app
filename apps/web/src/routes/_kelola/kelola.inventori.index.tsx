import { createFileRoute, redirect } from "@tanstack/react-router";

// /kelola/inventori — the inventory area landing screen. The items master data
// landing page comes with legend-qdc; until that merge this branch opens the
// stock card, so the sidebar entry never lands on a missing route.
export const Route = createFileRoute("/_kelola/kelola/inventori/")({
  beforeLoad: () => {
    throw redirect({ to: "/kelola/inventori/stok" });
  },
});
