import { createFileRoute } from "@tanstack/react-router";
import { AutomationsPage } from "@/features/ws08-crm-campaigns/components/automations-page";
import { CampaignsPage } from "@/features/ws08-crm-campaigns/components/campaign-shell";
import { campaignGuard } from "@/features/ws08-crm-campaigns/guard";

// /kelola/kampanye/otomasi — welcome, birthday, win-back and points-expiry
// reminder (PRD §3.21 "Otomasi"). The CRM contract has no automation endpoint
// yet, so the tab reads a local mock-only fixture; see the feature's
// automations.ts and the follow-up BE bead.
export const Route = createFileRoute("/_kelola/kelola/kampanye/otomasi")({
  beforeLoad: campaignGuard(["campaign.manage"]),
  component: AutomationsScreen,
});

function AutomationsScreen() {
  return (
    <CampaignsPage active="automations">
      <AutomationsPage />
    </CampaignsPage>
  );
}
