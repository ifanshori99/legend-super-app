// Page-level states of Pengaturan AI (mockup `loading`, `offline`, `session`).
// They replace the cards, so nothing can be changed while the page cannot be
// trusted to show the real settings.
import { useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { signInPath } from "@/features/ws01-login/flow";
import { AdminCard } from "@/features/ws12-ai-admin/components/shared";

function SkeletonCard({
  titleKey,
  rows,
  tall = false,
}: {
  titleKey: MessageKey;
  rows: ("short" | "line" | "field")[];
  tall?: boolean;
}) {
  const t = useT();
  return (
    <AdminCard className={tall ? "min-h-[300px]" : undefined}>
      <h2 className="type-title">{t(titleKey)}</h2>
      <div aria-hidden="true" className="grid gap-3">
        {rows.map((row, index) => (
          <Skeleton
            key={index}
            className={cn(
              "bg-border",
              row === "short" && "h-4 w-1/3",
              row === "line" && "h-4 w-full",
              row === "field" && "h-11 w-full",
            )}
          />
        ))}
      </div>
    </AdminCard>
  );
}

/** One `role=status` message, then the page layout as skeletons. */
export function AiSettingsLoading() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4">
      <p
        role="status"
        aria-live="polite"
        className="text-sm leading-5 text-muted-foreground"
      >
        {t("aiSettings.states.loadingStatus")}
      </p>
      <div
        aria-busy="true"
        className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:items-start"
      >
        <div className="grid min-w-0 gap-4">
          <SkeletonCard
            titleKey="aiSettings.states.cardChatgpt"
            rows={["short", "line", "line", "field"]}
            tall
          />
          <SkeletonCard
            titleKey="aiSettings.states.cardCustom"
            rows={["short", "field", "short", "field", "short", "field"]}
          />
        </div>
        <div className="grid min-w-0 gap-4">
          <SkeletonCard
            titleKey="aiSettings.states.cardBudget"
            rows={["short", "line", "field"]}
            tall
          />
          <SkeletonCard
            titleKey="aiSettings.order.title"
            rows={["line", "line"]}
          />
        </div>
      </div>
    </div>
  );
}

/** No connection: nothing was sent, and the visitor can retry. */
export function AiSettingsOffline({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  const t = useT();
  return (
    <AdminCard aria-labelledby="ai-offline-title" className="max-w-2xl">
      <h2 id="ai-offline-title" className="type-title">
        {t("aiSettings.states.offlineTitle")}
      </h2>
      <p role="alert" className="text-base leading-6 text-muted-foreground">
        {t("aiSettings.states.offlineBody")}
      </p>
      <p className="text-base leading-6 text-muted-foreground">
        {t("aiSettings.states.offlineHint")}
      </p>
      <div>
        <Button type="button" loading={retrying} onClick={onRetry}>
          {t("aiSettings.states.retry")}
        </Button>
      </div>
    </AdminCard>
  );
}

/** The settings failed to load for a reason other than no connection or an ended session. */
export function AiSettingsLoadError({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  const t = useT();
  return (
    <AdminCard aria-labelledby="ai-error-title" className="max-w-2xl">
      <h2 id="ai-error-title" className="type-title">
        {t("aiSettings.error.title")}
      </h2>
      <p role="alert" className="text-base leading-6 text-muted-foreground">
        {t("aiSettings.error.hint")}
      </p>
      <div>
        <Button type="button" loading={retrying} onClick={onRetry}>
          {t("aiSettings.states.retry")}
        </Button>
      </div>
    </AdminCard>
  );
}

/** Session over: sign in again, then come back to this page. */
export function AiSettingsSessionExpired() {
  const t = useT();
  const href = useLocation({ select: (location) => location.href });
  return (
    <AdminCard aria-labelledby="ai-session-title" className="max-w-2xl">
      <h2 id="ai-session-title" className="type-title">
        {t("aiSettings.states.sessionTitle")}
      </h2>
      <p role="alert" className="text-base leading-6 text-muted-foreground">
        {t("aiSettings.states.sessionBody")}
      </p>
      <p className="text-base leading-6 text-muted-foreground">
        {t("aiSettings.states.sessionHint")}
      </p>
      <div>
        <Button asChild>
          <a href={signInPath(href)}>{t("aiSettings.states.signInAgain")}</a>
        </Button>
      </div>
    </AdminCard>
  );
}
