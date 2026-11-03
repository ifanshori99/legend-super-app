import { createFileRoute } from "@tanstack/react-router";
import { accessGuard } from "@/features/ws01-access/guard";
import { ThemePage } from "@/features/ws01-tenant-settings/components/theme-page";

// /kelola/pengaturan/tema — Tenant Theme editor with the WCAG 2.2 AA gate
// (PRD §3 F4 "Whitelabel", TEN-10).
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/tema")({
  beforeLoad: accessGuard(["org.theme.manage"]),
  component: ThemeScreen,
});

function ThemeScreen() {
  const { access } = Route.useRouteContext();
  return <ThemePage access={access} />;
}
