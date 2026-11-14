// Status badges of the reservation desk: always icon + text, never color alone
// (DESIGN.md §4, WCAG 1.4.1). Labels come from the catalog so PRD terminology
// ("Menunggu DP", "Tidak datang") stays in one home.
import {
  Ban,
  BellRing,
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  Clock,
  RotateCcw,
  UserX,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type {
  PreOrderStatus,
  RescheduleRequestStatus,
  Reservation,
  ReservationStatus,
  WaitlistStatus,
} from "@starter/shared/reservation";
import type { PaymentStatus } from "@starter/shared/payment";
import {
  depositLabelKey,
  rescheduleStatusKey,
  reservationStatusKey,
  waitlistStatusKey,
} from "../lib";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const RESERVATION_STYLE: Record<
  ReservationStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  pending_deposit: { tone: "warning", icon: Clock },
  confirmed: { tone: "info", icon: CalendarCheck },
  seated: { tone: "success", icon: Users },
  completed: { tone: "neutral", icon: CircleCheck },
  cancelled: { tone: "neutral", icon: Ban },
  no_show: { tone: "danger", icon: UserX },
};

export function ReservationStatusBadge({
  status,
  className,
}: {
  status: ReservationStatus;
  className?: string;
}) {
  const t = useT();
  const { tone, icon: Icon } = RESERVATION_STYLE[status];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {t(reservationStatusKey(status))}
    </Badge>
  );
}

const DEPOSIT_STYLE: Record<
  PaymentStatus | "none",
  { tone: Tone; icon: LucideIcon }
> = {
  none: { tone: "neutral", icon: CircleCheck },
  pending: { tone: "warning", icon: Clock },
  paid: { tone: "success", icon: CircleCheck },
  failed: { tone: "danger", icon: CircleAlert },
  expired: { tone: "danger", icon: CircleAlert },
  refunded: { tone: "neutral", icon: RotateCcw },
  partially_refunded: { tone: "info", icon: RotateCcw },
};

/**
 * DP state of one reservation; a snapshot without DP shows "Tanpa DP", and a
 * pending DP with no intent yet shows "Menunggu pembayaran DP" (RSV-02).
 */
export function DepositBadge({
  reservation,
  className,
}: {
  reservation: Reservation;
  className?: string;
}) {
  const t = useT();
  const key =
    reservation.depositIdr > 0 ? (reservation.depositStatus ?? "none") : "none";
  const { tone, icon: Icon } = DEPOSIT_STYLE[key];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {t(depositLabelKey(reservation))}
    </Badge>
  );
}

const WAITLIST_STYLE: Record<WaitlistStatus, { tone: Tone; icon: LucideIcon }> =
  {
    waiting: { tone: "warning", icon: Clock },
    called: { tone: "info", icon: BellRing },
    seated: { tone: "success", icon: Users },
    left: { tone: "neutral", icon: Ban },
    cancelled: { tone: "neutral", icon: Ban },
  };

export function WaitlistStatusBadge({
  status,
  className,
}: {
  status: WaitlistStatus;
  className?: string;
}) {
  const t = useT();
  const { tone, icon: Icon } = WAITLIST_STYLE[status];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {t(waitlistStatusKey(status))}
    </Badge>
  );
}

const PRE_ORDER_TONE: Record<PreOrderStatus, Tone> = {
  draft: "neutral",
  confirmed: "info",
  preparing: "warning",
  served: "success",
  cancelled: "neutral",
};

export function PreOrderStatusBadge({
  status,
  className,
}: {
  status: PreOrderStatus;
  className?: string;
}) {
  const t = useT();
  return (
    <Badge tone={PRE_ORDER_TONE[status]} className={className}>
      {t(`reservation.detail.preOrderStatus.${status}`)}
    </Badge>
  );
}

const RESCHEDULE_STYLE: Record<
  RescheduleRequestStatus,
  { tone: Tone; icon: LucideIcon }
> = {
  pending: { tone: "warning", icon: Clock },
  approved: { tone: "success", icon: CircleCheck },
  declined: { tone: "danger", icon: Ban },
  withdrawn: { tone: "neutral", icon: Ban },
};

export function RescheduleStatusBadge({
  status,
  className,
}: {
  status: RescheduleRequestStatus;
  className?: string;
}) {
  const t = useT();
  const { tone, icon: Icon } = RESCHEDULE_STYLE[status];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {t(rescheduleStatusKey(status))}
    </Badge>
  );
}
