// Automation triggers (/kelola/kampanye/otomasi; PRD v1.7 §3.21 "Otomasi"):
// welcome, birthday, win-back and points-expiry reminder, each with its
// channel, on/off state, audience estimate and last run.
//
// The CRM contract has no automation endpoint, so this tab reads the local
// mock-only fixture (../automations.ts) and says so on screen. Toggles persist
// in this browser; nothing is sent to an API. The follow-up BE bead adds the
// contract endpoints and replaces the fixture.
//
// States: the fixture is synchronous, so there is no loading or error state to
// show; empty is unreachable (campaignAutomationSchema is a closed set of four).
// Offline does not block the tab because nothing is fetched — the shell still
// shows its offline notice.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useOutletClock } from "@/lib/tenant-context";
import { useAutomationSettings } from "../automations";
import {
  automationNameKey,
  automationRuleKey,
  channelLabelKey,
  formatDateTime,
} from "../lib";
import { Notice } from "./campaign-shell";

export function AutomationsPage() {
  const t = useT();
  const { timeZone } = useOutletClock();
  const { settings, toggle } = useAutomationSettings();

  return (
    <div className="grid min-w-0 gap-5">
      <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
        {t("crmCampaigns.automations.subtitle")}
      </p>
      <Notice tone="info" title={t("crmCampaigns.automations.previewTitle")}>
        {t("crmCampaigns.automations.previewNotice")}
      </Notice>
      <Notice tone="info" title={t("crmCampaigns.consent.title")}>
        {t("crmCampaigns.automations.consentNote")}
      </Notice>

      <div className="grid gap-4 sm:grid-cols-2">
        {settings.map((setting) => {
          const name = t(automationNameKey(setting.trigger));
          return (
            <Card key={setting.trigger} className="gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 gap-1">
                  <h3 className="type-title">{name}</h3>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t(automationRuleKey(setting.trigger))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={setting.enabled ? "success" : "neutral"}>
                    {setting.enabled
                      ? t("crmCampaigns.automations.enabled")
                      : t("crmCampaigns.automations.disabled")}
                  </Badge>
                  <Switch
                    checked={setting.enabled}
                    onCheckedChange={(checked) =>
                      toggle(setting.trigger, checked)
                    }
                    aria-label={t("crmCampaigns.automations.toggleLabel", {
                      name,
                    })}
                  />
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("crmCampaigns.automations.channelLabel")}
                  </dt>
                  <dd>
                    <Badge tone="neutral">
                      {t(channelLabelKey(setting.channel))}
                    </Badge>
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("crmCampaigns.automations.audienceLabel")}
                  </dt>
                  <dd className="tabular font-semibold">
                    {t("crmCampaigns.automations.audienceValue", {
                      count: setting.audienceEstimate,
                    })}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="type-eyebrow text-muted-foreground">
                    {t("crmCampaigns.automations.lastRunLabel")}
                  </dt>
                  <dd className="tabular">
                    {setting.lastRunAt === null
                      ? t("crmCampaigns.automations.lastRunNever")
                      : formatDateTime(setting.lastRunAt, timeZone)}
                  </dd>
                </div>
              </dl>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
