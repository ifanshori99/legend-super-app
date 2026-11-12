// What went wrong (or why asking is paused) and how to recover. Every state has
// an icon and words, never colour alone; denied, unavailable, quota, budget and
// PII refusals each have their own text (classifyAskError in ../logic).
import { Link } from "@tanstack/react-router";
import {
  RotateCw,
  ShieldAlert,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { reportPath, type AskErrorKind, type ChatArea } from "../logic";

export type BannerKind = AskErrorKind | "offline" | "featureOff" | "stopped";

const ICONS: Record<Exclude<BannerKind, "stopped">, LucideIcon> = {
  denied: ShieldAlert,
  unavailable: TriangleAlert,
  quota: TriangleAlert,
  budget: TriangleAlert,
  pii: ShieldAlert,
  featureOff: TriangleAlert,
  error: TriangleAlert,
  offline: WifiOff,
};

/** Kinds where trying again can help without changing anything. */
const RETRYABLE: readonly BannerKind[] = [
  "unavailable",
  "error",
  "offline",
  "stopped",
];
/** Kinds where the numbers are still one click away in the reports. */
const REPORT_LINK: readonly BannerKind[] = [
  "unavailable",
  "quota",
  "budget",
  "featureOff",
  "error",
];

export function AskBanner({
  kind,
  area,
  urgent = true,
  onRetry,
  retrying = false,
}: {
  kind: BannerKind;
  area: ChatArea;
  /** Announced at once (an answer just failed) rather than politely. */
  urgent?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useT();
  const Icon = kind === "stopped" ? TriangleAlert : ICONS[kind];
  const title =
    kind === "stopped"
      ? t("aiChat.answer.stopped")
      : t(`aiChat.banner.${kind}.title`);
  const body = kind === "stopped" ? null : t(`aiChat.banner.${kind}.body`);
  return (
    <div
      role={urgent ? "alert" : "status"}
      data-kind={kind}
      className="grid gap-2 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-4"
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        {title}
      </p>
      {body && <p className="text-sm leading-5">{body}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {onRetry && RETRYABLE.includes(kind) && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onRetry}
            loading={retrying}
          >
            <RotateCw aria-hidden="true" />
            {t("aiChat.answer.retry")}
          </Button>
        )}
        {REPORT_LINK.includes(kind) && (
          <Link
            to={reportPath(area) as "/"}
            className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
          >
            {t("aiChat.banner.unavailable.openReport")}
          </Link>
        )}
      </div>
    </div>
  );
}
