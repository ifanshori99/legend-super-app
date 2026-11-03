import { createFileRoute } from "@tanstack/react-router";
import { accessGuard } from "@/features/ws01-access/guard";
import { IntegrationsPage } from "@/features/ws01-tenant-settings/components/integrations-page";

// /kelola/pengaturan/integrasi — per-tenant integrations with write-only
// credentials (PRD §3 F4 "Integrasi per Tenant", PAY-06).
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/integrasi")({
  beforeLoad: accessGuard(["org.integration.manage"]),
  component: IntegrationsScreen,
});

function IntegrationsScreen() {
  const { access } = Route.useRouteContext();
  return <IntegrationsPage access={access} />;
}
