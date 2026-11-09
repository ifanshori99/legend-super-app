import type { ReactNode } from "react";
import { cn } from "cn";

// Page title of a POS cashier screen: title and subtitle on the left, the back
// action on the right. The ops shell already carries the header (outlet,
// terminal, connection), so this is the only heading a screen adds.
export function PosPageHeading({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  /** Usually the "back" button. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="pos-page-heading"
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="type-display">{title}</h1>
        {subtitle && (
          <p className="text-(length:--density-text) text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
