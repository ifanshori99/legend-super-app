// One titled card inside a facility config tab. Card is the shared container
// (DESIGN.md v3 §4): the tab content is already inside the work-area canvas, so
// this adds no shell. h2, never h1: the management topbar owns the page title.
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function ConfigSection({
  title,
  description,
  action,
  slot,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Stable data-slot for the e2e spec. */
  slot: string;
  children: ReactNode;
}) {
  return (
    <Card data-slot={slot}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="type-heading">{title}</h2>
          {description && (
            <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}
