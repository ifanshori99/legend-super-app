// Status is always icon + text (DESIGN.md §4). Statutory versions use the
// shared StatusPill tones: draft = info, published = success, archived =
// neutral; the effective state reads as a separate badge because "terbit" and
// "berlaku sekarang" are different facts (PAYR-02).
import {
  Archive,
  CalendarClock,
  CircleCheck,
  FilePenLine,
  TriangleAlert,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import type { StatutoryTableVersion } from "@starter/shared/hris/payroll";
import {
  STATUTORY_STATUS_KEYS,
  effectiveVersion,
  formatBusinessDate,
  hasPublishedOnDate,
} from "../lib";

export function StatutoryStatusPill({
  status,
}: {
  status: StatutoryTableVersion["status"];
}) {
  const t = useT();
  if (status === "published")
    return (
      <StatusPill status="success" icon={CircleCheck}>
        {t(STATUTORY_STATUS_KEYS.published)}
      </StatusPill>
    );
  if (status === "draft")
    return (
      <StatusPill status="info" icon={FilePenLine}>
        {t(STATUTORY_STATUS_KEYS.draft)}
      </StatusPill>
    );
  return (
    <StatusPill status="delivered" icon={Archive}>
      {t(STATUTORY_STATUS_KEYS.archived)}
    </StatusPill>
  );
}

/**
 * Whether a published version is in force today, starts later, or has been
 * replaced. Drafts and archived rows get no badge: their status pill says it.
 */
export function StatutoryEffectiveBadge({
  version,
  versions,
  today,
}: {
  version: StatutoryTableVersion;
  versions: readonly StatutoryTableVersion[];
  today: string;
}) {
  const t = useT();
  if (version.status !== "published") return null;
  if (version.effectiveFrom > today)
    return (
      <Badge tone="info">
        <CalendarClock aria-hidden="true" />
        {t("payrollConfig.statutory.scheduled", {
          date: formatBusinessDate(version.effectiveFrom),
        })}
      </Badge>
    );
  // Two published versions on one date: payroll refuses the table, so neither
  // is "superseded" — say so (the compliance banner lists the conflict).
  if (
    hasPublishedOnDate(
      versions,
      version.type,
      version.effectiveFrom,
      version.id,
    )
  )
    return (
      <Badge tone="danger">
        <TriangleAlert aria-hidden="true" />
        {t("payrollConfig.statutory.ambiguous")}
      </Badge>
    );
  const inForce = effectiveVersion(versions, version.type, today);
  if (inForce?.id === version.id)
    return (
      <Badge tone="success">
        <CircleCheck aria-hidden="true" />
        {t("payrollConfig.statutory.effectiveNow")}
      </Badge>
    );
  return (
    <Badge tone="neutral">{t("payrollConfig.statutory.superseded")}</Badge>
  );
}
