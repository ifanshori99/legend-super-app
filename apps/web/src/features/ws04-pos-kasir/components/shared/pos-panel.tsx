import { useId, type ReactNode } from "react";
import { cn } from "cn";

// A bordered work card: title with an optional pill on the right, the body,
// and an optional action footer aligned bottom-right. Fills the height of its
// column so two panels side by side end on the same line. The footer sticks to
// the bottom of the scrolling area (solid card surface, top border) so the
// primary action stays in reach when the panel is taller than the viewport.
export function PosPanel({
  title,
  aside,
  footer,
  children,
  className,
}: {
  title: string;
  /** Usually a `StatusPill` or a count. */
  aside?: ReactNode;
  /** Actions, right-aligned; the primary action comes last. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section
      data-slot="pos-panel"
      aria-labelledby={titleId}
      className={cn(
        "flex h-full flex-col gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="type-title">
          {title}
        </h2>
        {aside}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
      {footer && (
        <footer className="sticky bottom-0 z-10 -mx-card -mb-card flex flex-wrap justify-end gap-3 rounded-b-container border-t-(length:--border-w) border-border bg-card px-card py-4">
          {footer}
        </footer>
      )}
    </section>
  );
}
