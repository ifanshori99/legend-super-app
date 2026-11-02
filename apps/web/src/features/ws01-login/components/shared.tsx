// Pieces shared by the sign-in screens. They compose components/ui (DESIGN.md)
// instead of adding new visual primitives: a tinted notice, an inline API
// failure with its fix hint, a success panel, and the clock the code countdown
// reads. Bead legend-baa.
import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { loginErrorKey } from "../flow";

/** Tints the design system already defines; text and icon carry the meaning. */
export type NoticeTone = "warning" | "danger" | "success" | "info" | "muted";

const TONE_CLASS: Record<NoticeTone, string> = {
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  success: "bg-success-subtle text-success",
  info: "bg-info-subtle text-info",
  muted: "bg-muted text-muted-foreground",
};

/**
 * A block of state: icon + title + hint (+ an action). Icon and text always
 * travel together, so tone never carries the meaning alone (DESIGN §2).
 */
export function Notice({
  tone,
  icon: Icon,
  title,
  hint,
  action,
  live = false,
  className,
}: {
  tone: NoticeTone;
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** Announce appearance and changes to assistive tech. */
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      className={cn(
        "grid gap-3 rounded-xl p-card sm:grid-cols-[auto_minmax(0,1fr)]",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-background/60">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <p className="text-base leading-6 font-semibold">{title}</p>
        {hint && <div className="text-sm leading-5">{hint}</div>}
        {action && <div className="mt-1">{action}</div>}
      </div>
    </div>
  );
}

/** Inline failure next to the action that failed, with a retry (PRD: fix hint). */
export function InlineFailure({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-sm leading-5 text-danger",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{t(loginErrorKey(error))}</p>
      {onRetry && (
        <Button variant="link" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/** The settled state after a session exists. */
export function SuccessPanel({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action: ReactNode;
}) {
  return (
    <Notice
      tone="success"
      icon={CheckCircle2}
      title={title}
      hint={hint}
      action={action}
      live
    />
  );
}

/**
 * The current instant while `active`, or null before mount. Null keeps the
 * first render (SSR and hydration) identical: only the countdown uses it.
 */
export function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "03.24" — the wall clock the guest reads on their own device. */
export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
