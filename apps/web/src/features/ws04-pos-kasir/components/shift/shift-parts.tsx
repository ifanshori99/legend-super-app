import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { isContractPending } from "../../hooks";
import { Notice, PosTwoPane } from "../shared";

// Small pieces the three shift screens share.

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
}: {
  title: string;
  error: unknown;
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
    </Notice>
  );
}
