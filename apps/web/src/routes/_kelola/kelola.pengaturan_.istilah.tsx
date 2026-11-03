import { createFileRoute } from "@tanstack/react-router";
import { accessGuard } from "@/features/ws01-access/guard";
import { TermsPage } from "@/features/ws01-tenant-settings/components/terms-page";

// /kelola/pengaturan/istilah — tenant term dictionary, Super Admin only
// (PRD §3 F4 "Teks & Kamus Istilah"). The platform permission hides the page
// from tenant admins; the API checks it again.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/istilah")({
  beforeLoad: accessGuard(["platform.tenant.manage"]),
  component: TermsScreen,
});

function TermsScreen() {
  const { access } = Route.useRouteContext();
  return <TermsPage access={access} />;
}
