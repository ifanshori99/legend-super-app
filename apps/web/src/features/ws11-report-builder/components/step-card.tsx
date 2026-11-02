// One panel of the builder: the DESIGN.md v3 double shell with a numbered
// heading, so the steps read top to bottom (metric, split, filter, period).
import type { ReactNode } from "react";
import { cn } from "cn";
import { CardShell, CardShellBody } from "@/components/ui/card";

export function StepCard({
  step,
  title,
  hint,
  action,
  className,
  children,
}: {
  /** Step number; omit for panels that are not part of the sequence. */
  step?: number;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <CardShell className={className}>
      <CardShellBody>
        <section className="grid gap-4 p-card">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="type-heading flex items-center gap-2">
                {step !== undefined && (
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold tabular"
                  >
                    {step}
                  </span>
                )}
                <span className="min-w-0">{title}</span>
              </h2>
              {hint && (
                <p
                  className={cn(
                    "mt-1 text-sm leading-5 text-muted-foreground",
                    step !== undefined && "ps-8",
                  )}
                >
                  {hint}
                </p>
              )}
            </div>
            {action}
          </header>
          {children}
        </section>
      </CardShellBody>
    </CardShell>
  );
}
