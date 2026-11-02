import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Ticket,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/i18n";
import type { MembershipStatus, VoucherDto } from "@starter/shared/crm";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const MEMBERSHIP: Record<MembershipStatus, { tone: Tone; icon: LucideIcon }> = {
  active: { tone: "success", icon: CircleCheck },
  pending_verification: { tone: "warning", icon: Clock },
  suspended: { tone: "danger", icon: CircleAlert },
  closed: { tone: "neutral", icon: CircleSlash },
};

// Status is always icon + text (DESIGN.md: never color alone). Membership is
// PRD §3.20: active only after verified WhatsApp + loyalty consent.
export function MembershipStatusBadge({
  status,
}: {
  status: MembershipStatus;
}) {
  const t = useT();
  const { tone, icon: Icon } = MEMBERSHIP[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden="true" />
      {t(`member.status.${status}`)}
    </Badge>
  );
}

const VOUCHER: Record<VoucherDto["status"], { tone: Tone; icon: LucideIcon }> =
  {
    issued: { tone: "info", icon: Ticket },
    redeemed: { tone: "neutral", icon: CircleCheck },
    expired: { tone: "warning", icon: Clock },
    cancelled: { tone: "danger", icon: CircleSlash },
  };

export function VoucherStatusBadge({
  status,
}: {
  status: VoucherDto["status"];
}) {
  const t = useT();
  const { tone, icon: Icon } = VOUCHER[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden="true" />
      {t(`member.vouchers.status.${status}`)}
    </Badge>
  );
}

export function MembershipRequirement({
  met,
  children,
}: {
  met: boolean;
  children: ReactNode;
}) {
  const Icon = met ? CircleCheck : TriangleAlert;
  return (
    <li className="flex items-start gap-2 text-sm leading-5">
      <Icon
        className={
          met
            ? "mt-0.5 size-4 shrink-0 text-success"
            : "mt-0.5 size-4 shrink-0 text-warning"
        }
        aria-hidden="true"
      />
      <span className={met ? "text-foreground" : "text-muted-foreground"}>
        {children}
      </span>
    </li>
  );
}
