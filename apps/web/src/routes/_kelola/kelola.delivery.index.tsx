import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import {
  DeliveryScreen,
  type DeliveryTab,
} from "@/features/ws08-delivery/components/delivery-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /kelola/delivery — ojek online delivery ops (PRD v1.7 §3.23 "Integrasi Ojek
// Online" / F20, §4 Alur G, D12 "Mode Manual"). The kelola layout already
// requires dashboard.management.view + MFA; this page additionally needs one of
// the two delivery permissions. Guard is presentation only; the API re-checks
// every request. Search state is deep-linkable so a tab can be opened directly
// (also what the e2e spec drives).
const searchSchema = z.object({
  tab: z
    .enum(["kanal", "pesanan", "rekonsiliasi"])
    .catch("kanal")
    .default("kanal"),
});

export const Route = createFileRoute("/_kelola/kelola/delivery/")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["delivery.channel.manage", "delivery.order.handle"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: DeliveryRoute,
});

function DeliveryRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DeliveryScreen
      tab={search.tab}
      onTabChange={(tab: DeliveryTab) =>
        void navigate({ search: (prev) => ({ ...prev, tab }) })
      }
    />
  );
}
