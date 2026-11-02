// A rule version's status always reads as icon + text (DESIGN.md §4), plus
// whether the version is the one in force today (PRD R20/R21: effective dates
// pick the version; a tombstone version ends its code).
import {
  Archive,
  CalendarClock,
  CircleCheck,
  CircleSlash,
  FilePenLine,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { VERSION_STATUS_KEYS } from "../labels";
import { isEffectiveVersion, type RuleVersion } from "../lib";

export function VersionStatusBadge({
  version,
}: {
  version: { status: keyof typeof VERSION_STATUS_KEYS; version: number };
}) {
  const t = useT();
  const tone =
    version.status === "published"
      ? "success"
      : version.status === "draft"
        ? "info"
        : "neutral";
  const Icon =
    version.status === "published"
      ? CircleCheck
      : version.status === "draft"
        ? FilePenLine
        : Archive;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(VERSION_STATUS_KEYS[version.status])}
      {" · "}
      {t("tax.versionLabel", { version: version.version })}
    </Badge>
  );
}

export function EffectiveBadge<T extends RuleVersion>({
  version,
  versions,
  today,
}: {
  version: T;
  versions: readonly T[];
  today: string;
}) {
  const t = useT();
  if (version.status !== "published") return null;
  if (version.effectiveFrom > today)
    return (
      <Badge tone="info">
        <CalendarClock aria-hidden="true" />
        {t("tax.effective.scheduled")}
      </Badge>
    );
  if (!isEffectiveVersion(version, versions, today)) return null;
  return version.isActive ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t("tax.effective.now")}
    </Badge>
  ) : (
    <Badge tone="warning">
      <CircleSlash aria-hidden="true" />
      {t("tax.effective.ended")}
    </Badge>
  );
}
