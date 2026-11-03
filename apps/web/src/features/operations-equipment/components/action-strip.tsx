// "Perlu tindakan" strip (DESIGN.md §5 per-area guidance): the first block on
// an operations screen, one row per state that needs a supervisor. The urgent
// count is a solid status pill; calm attention stays tinted (owner Q25).
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function ActionStrip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} data-slot="action-strip">
      <Card className="gap-3">
        <h2 className="type-title">{label}</h2>
        <div className="grid gap-3">{children}</div>
      </Card>
    </section>
  );
}

export function ActionRow({
  title,
  hint,
  pill,
  children,
}: {
  title: string;
  hint?: string;
  pill: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="action-row"
      className="grid gap-2 rounded-container border-(length:--border-w) border-border p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start sm:gap-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        {pill}
        <h3 className="type-heading">{title}</h3>
      </div>
      <div className="grid min-w-0 gap-1 sm:col-start-2">
        {hint && (
          <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
        )}
        {children}
      </div>
    </div>
  );
}
