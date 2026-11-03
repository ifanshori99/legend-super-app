// Status pills for campaigns and their sends. Status is always icon + text,
// never color alone (DESIGN.md §4 Status). Campaign states reuse the catalog
// status kinds: draft/scheduled read as information, running needs attention,
// completed is success, cancelled is neutral.
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  FilePen,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill, type StatusKind } from "@/components/ui/badge";
import type { CampaignSendStatus, CampaignStatus } from "@starter/shared/crm";
import { campaignStatusLabelKey, sendStatusLabelKey } from "../lib";

const CAMPAIGN_STATUS: Record<
  CampaignStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  draft: { status: "info", icon: FilePen },
  scheduled: { status: "info", icon: CalendarClock },
  running: { status: "warning", icon: Clock },
  completed: { status: "success", icon: CircleCheck },
  cancelled: { status: "delivered", icon: CircleSlash },
};

const SEND_STATUS: Record<
  CampaignSendStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  queued: { status: "info", icon: Clock },
  sent: { status: "info", icon: Send },
  delivered: { status: "success", icon: CircleCheck },
  failed: { status: "danger", icon: CircleAlert },
  skipped_no_consent: { status: "delivered", icon: CircleSlash },
};

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  const t = useT();
  const { status: kind, icon } = CAMPAIGN_STATUS[status];
  return (
    <StatusPill status={kind} icon={icon} className="text-xs">
      {t(campaignStatusLabelKey(status))}
    </StatusPill>
  );
}

export function SendStatusPill({ status }: { status: CampaignSendStatus }) {
  const t = useT();
  const { status: kind, icon } = SEND_STATUS[status];
  return (
    <StatusPill status={kind} icon={icon} className="text-xs">
      {t(sendStatusLabelKey(status))}
    </StatusPill>
  );
}
