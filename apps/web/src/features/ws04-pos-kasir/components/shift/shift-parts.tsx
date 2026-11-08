import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isContractPending } from "../../hooks";
import { Notice, PosTwoPane } from "../shared";

// Small pieces the three shift screens share.

/**
 * Ref for a screen root: when `enabled` at mount, moves focus to the screen's
 * heading. Used after a step swaps the screen (recount, cancel, send), so the
 * focused button does not vanish and leave keyboard focus on the page body.
 */
export function useFocusHeading(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const heading = ref.current?.querySelector("h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
    // Only on mount: the flag is already set when the new screen appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** A labelled value in the side panel: small caps label, bold value. */
export function ContextBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b-(length:--border-w) border-border pb-4">
      <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="text-(length:--density-text) font-semibold">
        {children}
      </div>
    </div>
  );
}

/** Loading shape of a two-pane shift screen. */
export function ShiftScreenSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" role="status" className="grid gap-4">
      <span className="sr-only">{label}</span>
      <div className="grid gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <PosTwoPane side={<Skeleton className="h-96 rounded-container" />}>
        <Skeleton className="h-96 rounded-container" />
      </PosTwoPane>
    </div>
  );
}

/** A failed action (open, save, send): what went wrong and how to recover. */
export function ActionError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const t = useT();
  const pending = isContractPending(error);
  const message =
    error instanceof Error && error.message !== "" ? error.message : null;
  return (
    <Notice
      tone="danger"
      title={pending ? t("posKasirShift.error.pending") : title}
    >
      {pending
        ? t("posKasirShift.error.pendingHint")
        : (message ?? t("posKasirShift.error.hint"))}
      {onRetry && (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </div>
      )}
    </Notice>
  );
}
