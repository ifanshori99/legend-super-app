// Status rendering shared by the employee master screens: every status is a
// pill with an icon + text (DESIGN.md §4, never colour alone), and the labels
// come from the catalog so a tenant can override them.
import {
  CircleCheck,
  CircleMinus,
  CircleOff,
  CirclePause,
  Clock,
  FileText,
  RefreshCw,
  Ban,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  EmployeeDocument,
  EmployeeStatus,
  EmploymentContractStatus,
  EmploymentType,
} from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { documentExpired, documentVerified } from "../lib";

/** The badge tones (StatusPill's catalog has no neutral state). */
type PillTone = "neutral" | "success" | "warning" | "danger" | "info";

type StatusSpec = {
  tone: PillTone;
  icon: LucideIcon;
  labelKey: MessageKey;
};

/** PRD §6 H `employees.status`: tone + glyph per state. */
const EMPLOYEE_STATUS: Record<EmployeeStatus, StatusSpec> = {
  onboarding: {
    tone: "info",
    icon: Clock,
    labelKey: "employeeMaster.status.onboarding",
  },
  active: {
    tone: "success",
    icon: CircleCheck,
    labelKey: "employeeMaster.status.active",
  },
  suspended: {
    tone: "warning",
    icon: CirclePause,
    labelKey: "employeeMaster.status.suspended",
  },
  resigned: {
    tone: "neutral",
    icon: CircleMinus,
    labelKey: "employeeMaster.status.resigned",
  },
  terminated: {
    tone: "neutral",
    icon: CircleOff,
    labelKey: "employeeMaster.status.terminated",
  },
};

/**
 * StatusPill has no neutral status (its catalog is order/KDS states), and an
 * exit state must never borrow "success"; this renders the same pill with the
 * tone taken from the employee lifecycle.
 */
function StatusBadge({
  tone,
  icon: Icon,
  children,
}: {
  tone: PillTone;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="status-pill"
      className={cn(badgeVariants({ tone }), "rounded-full px-2.5 text-sm")}
    >
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

export function EmployeeStatusPill({ status }: { status: EmployeeStatus }) {
  const t = useT();
  const spec = EMPLOYEE_STATUS[status];
  return (
    <StatusBadge tone={spec.tone} icon={spec.icon}>
      {t(spec.labelKey)}
    </StatusBadge>
  );
}

export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, MessageKey> = {
  pkwtt: "employeeMaster.employmentType.pkwtt",
  pkwt: "employeeMaster.employmentType.pkwt",
  daily: "employeeMaster.employmentType.daily",
  intern: "employeeMaster.employmentType.intern",
};

export function EmploymentTypeBadge({ type }: { type: EmploymentType }) {
  const t = useT();
  return <Badge tone="neutral">{t(EMPLOYMENT_TYPE_LABEL[type])}</Badge>;
}

/** Employment contract lifecycle (PRD §6 H `employment_contracts.status`). */
const CONTRACT_STATUS: Record<EmploymentContractStatus, StatusSpec> = {
  draft: {
    tone: "neutral",
    icon: FileText,
    labelKey: "employeeMaster.profile.contracts.statuses.draft",
  },
  active: {
    tone: "success",
    icon: CircleCheck,
    labelKey: "employeeMaster.profile.contracts.statuses.active",
  },
  expired: {
    tone: "warning",
    icon: CirclePause,
    labelKey: "employeeMaster.profile.contracts.statuses.expired",
  },
  renewed: {
    tone: "info",
    icon: RefreshCw,
    labelKey: "employeeMaster.profile.contracts.statuses.renewed",
  },
  terminated: {
    tone: "neutral",
    icon: Ban,
    labelKey: "employeeMaster.profile.contracts.statuses.terminated",
  },
};

export function ContractStatusPill({
  status,
}: {
  status: EmploymentContractStatus;
}) {
  const t = useT();
  const spec = CONTRACT_STATUS[status];
  return (
    <StatusBadge tone={spec.tone} icon={spec.icon}>
      {t(spec.labelKey)}
    </StatusBadge>
  );
}

/** Verified / unverified, and an expired document in its own warning tone. */
export function DocumentVerificationBadges({
  document,
  today,
}: {
  document: EmployeeDocument;
  today: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {documentVerified(document) ? (
        <Badge tone="success">
          {t("employeeMaster.profile.documents.verified")}
        </Badge>
      ) : (
        <Badge tone="neutral">
          {t("employeeMaster.profile.documents.unverified")}
        </Badge>
      )}
      {documentExpired(document, today) && (
        <Badge tone="warning">
          {t("employeeMaster.profile.documents.expired")}
        </Badge>
      )}
    </div>
  );
}
