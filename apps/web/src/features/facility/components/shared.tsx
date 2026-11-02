// Small pieces shared by the facility screens: the ticket status pill, the
// booking stepper, loading shapes and the inline API failure note. They compose
// components/ui (DESIGN.md) instead of adding new visual primitives.
import type { ReactNode } from "react";
import { CircleAlert, Check } from "lucide-react";
import type { AccessTicketStatus } from "@starter/shared/facility";
import type { Translate } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors.ts";
import { cn } from "cn";
import { ticketStatusMeta } from "../flow";

/** Ticket status always reads as icon + text (DESIGN.md: never color alone). */
export function TicketStatusPill({
  status,
  className,
}: {
  status: AccessTicketStatus;
  className?: string;
}) {
  const t = useT();
  const meta = ticketStatusMeta(status);
  return (
    <StatusPill status={meta.tone} className={className}>
      {t(`facility.ticket.status.${meta.key}`)}
    </StatusPill>
  );
}

/** API message when there is one; the catalog's fix hint otherwise. */
export function apiErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError && error.status > 0 && error.message)
    return error.message;
  return t("state.errorHint");
}

/** Inline failure next to the action that failed, with a retry. */
export function ApiFailure({
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
        "flex items-start gap-2 rounded-container bg-danger-subtle px-3 py-2 text-sm leading-5 text-danger",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{apiErrorMessage(error, t)}</p>
      {onRetry && (
        <Button variant="link" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

const STEP_KEYS = ["login", "schedule", "extras", "pay"] as const;
export type BookingStep = (typeof STEP_KEYS)[number];

/** Where the guest is in the booking journey (alur S langkah 2–4). The v3
 * progress track mirrors the tab group: the current step is a card chip with a
 * hairline ring on the `surface-2` track, never an accent fill (Q21). */
export function JourneyStepper({ current }: { current: BookingStep }) {
  const t = useT();
  const currentIndex = STEP_KEYS.indexOf(current);
  return (
    <ol
      aria-label={t("facility.steps.label")}
      className="flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-control border-(length:--border-w) bg-surface-2 p-1 [scrollbar-width:none]"
    >
      {STEP_KEYS.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li
            key={step}
            className="flex shrink-0 items-center gap-0.5 text-sm leading-5"
          >
            {index > 0 && (
              <span
                aria-hidden="true"
                className="mx-1 hidden h-px w-3 shrink-0 bg-border sm:block"
              />
            )}
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-2.5 py-1.5 font-medium whitespace-nowrap transition-colors duration-(--duration-fast)",
                active &&
                  "bg-card font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)]",
                done && "text-foreground",
                !active && !done && "text-muted-foreground",
              )}
            >
              {done ? (
                <Check className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <span className="tabular" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span className="truncate">{t(`facility.steps.${step}`)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Loading shape for a card the guest is waiting on. */
export function LoadingCard({ lines = 3 }: { lines?: number }) {
  const t = useT();
  return (
    <div role="status" aria-busy="true" className="grid gap-3">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** A labelled block inside a page: heading + body. The block is not itself a
 * card, so the frame a step puts inside it (a `Card`, a divided list container)
 * never ends up nested in another card (DESIGN.md §4). */
export function Section({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid gap-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-brand type-heading">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
