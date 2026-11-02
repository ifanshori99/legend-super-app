import { createFileRoute, notFound } from "@tanstack/react-router";
import { KdsPage } from "@/features/ws04-kds/components/kds-page";
import { evaluateGuard } from "@/lib/areas/guard";

export const Route = createFileRoute("/_kitchen/kds/")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "kds", anyOf: ["kds.ticket.process"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: KdsPage,
});
