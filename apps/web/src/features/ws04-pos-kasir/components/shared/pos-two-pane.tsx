import type { ReactNode } from "react";
import { cn } from "cn";

// Two columns of a cashier screen: a fixed side panel (about 400 px) and a
// work panel that takes the rest. Below 768 px the columns stack in DOM order,
// so no horizontal scroll at 390 px.
export function PosTwoPane({
  side,
  children,
  sidePosition = "start",
  className,
}: {
  /** The fixed panel: the bill, or the count summary. */
  side: ReactNode;
  /** The work panel. */
  children: ReactNode;
  /** `end` puts the fixed panel on the right (shift close). */
  sidePosition?: "start" | "end";
  className?: string;
}) {
  const sideFirst = sidePosition === "start";
  return (
    <div
      data-slot="pos-two-pane"
      className={cn(
        "grid items-stretch gap-4",
        sideFirst
          ? "md:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]"
          : "md:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]",
        className,
      )}
    >
      {sideFirst ? (
        <>
          <div className="min-w-0">{side}</div>
          <div className="min-w-0">{children}</div>
        </>
      ) : (
        <>
          <div className="min-w-0">{children}</div>
          <div className="min-w-0">{side}</div>
        </>
      )}
    </div>
  );
}
