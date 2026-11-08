import type { ReactNode } from "react";
import { cn } from "cn";
import { Money } from "@/components/ui/money";
import { StatusPill, type StatusPillTone } from "./status-pill";

// One payment already taken or reserved against a bill: title with a status
// pill, a reference line with the amount on the right, and a short note.
export function TenderCard({
  title,
  status,
  reference,
  amountIdr,
  note,
  className,
}: {
  title: string;
  status: { tone: StatusPillTone; label: string };
  /** "Pembayaran 01", "RSV-0018", a bank reference. */
  reference: string;
  amountIdr: number;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <article
      data-slot="tender-card"
      className={cn(
        "grid gap-2 rounded-container border-(length:--border-w) border-border bg-card p-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="type-heading">{title}</h3>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-(length:--density-text)">
        <span className="tabular min-w-0 break-words">{reference}</span>
        <Money amount={amountIdr} className="font-semibold" />
      </div>
      {note && <p className="tabular text-sm text-muted-foreground">{note}</p>}
    </article>
  );
}
