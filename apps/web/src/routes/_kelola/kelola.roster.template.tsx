import { createFileRoute } from "@tanstack/react-router";
import { RosterShell } from "@/features/ws10-roster/components/roster-shell";
import { TemplatesPage } from "@/features/ws10-roster/components/templates-page";
import { rosterGuard } from "@/features/ws10-roster/guard";
import { isMockScenarioRequest } from "@/features/ws10-roster/lib";
import { positionsQuery } from "@/features/ws10-roster/queries";

// /kelola/roster/template — shift-template catalog (PRD v1.7 §3 Kelompok D 28
// "Template Shift", F26). Read-only until the template endpoints land.
export const Route = createFileRoute("/_kelola/kelola/roster/template")({
  beforeLoad: rosterGuard(["hr.schedule.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(positionsQuery()),
  component: TemplateScreen,
});

function TemplateScreen() {
  return (
    <RosterShell active="templates">
      <TemplatesPage />
    </RosterShell>
  );
}
