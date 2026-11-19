import type { ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Card } from "@/components/ui/card";

// Shared layout pieces for the member "Tukar poin di kasir" flow (brief 1165).
// Presentational only: copy comes in as props, never from this file.

/** One panel is on screen at a time, so its title id is a constant the page
 * can focus when the step changes. */
export const PANEL_TITLE_ID = "tukar-poin-panel-title";

// Context first, then the panel: one column on a phone, two columns from md.
export function FlowGrid({
  context,
  panel,
  busy,
}: {
  context: ReactNode;
  panel: ReactNode;
  busy?: boolean;
}) {
  return (
    <div
      aria-busy={busy || undefined}
      className="grid items-start gap-6 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:gap-10"
    >
      <div className="grid min-w-0 gap-5">{context}</div>
      {panel}
    </div>
  );
}

export function Panel({
  labelledBy = PANEL_TITLE_ID,
  children,
}: {
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={labelledBy} className="min-w-0">
      <Card className="gap-5 md:p-7">{children}</Card>
    </section>
  );
}

/** The panel's h2. Programmatically focusable so a step change can land here. */
export function PanelTitle({ children }: { children: ReactNode }) {
  return (
    <h2
      id={PANEL_TITLE_ID}
      tabIndex={-1}
      className="font-brand type-title outline-none"
    >
      {children}
    </h2>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="type-eyebrow text-muted-foreground">{children}</p>;
}

const NOTE_TONES = {
  info: { box: "border-border bg-surface-3 text-foreground", icon: Info },
  warning: {
    box: "border-warning/25 bg-warning-subtle text-warning",
    icon: TriangleAlert,
  },
  success: {
    box: "border-success/25 bg-success-subtle text-success",
    icon: CircleCheck,
  },
} as const;

// A tinted note with a hairline border (no side-tab accent). The icon backs up the colour (WCAG 1.4.1); success and
// warning are announced, info is plain reading text.
export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "success";
  children: ReactNode;
}) {
  const { box, icon: Icon } = NOTE_TONES[tone];
  return (
    <div
      role={tone === "info" ? undefined : "status"}
      className={cn(
        "flex items-start gap-3 rounded-container border px-4 py-3 text-sm leading-5",
        box,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SummaryBox({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      role={label ? "group" : undefined}
      aria-label={label}
      className="grid gap-3 rounded-container bg-surface-3 p-4 md:p-5"
    >
      {children}
    </div>
  );
}

// `strong` is the total row: heavier and set off by a rule above it.
export function SummaryRow({
  label,
  value,
  strong,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm leading-5",
        strong && "border-t-(length:--border-w) border-border pt-3 font-bold",
      )}
    >
      <span>{label}</span>
      <span className={cn("tabular font-semibold", strong && "font-bold")}>
        {value}
      </span>
    </div>
  );
}

// The one large figure on a screen. `label` is the accessible name when the
// figure is a placeholder (for example "Sedang dimuat"); the visible text is
// then hidden from assistive tech so it is not read twice.
export function BigAmount({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <p className="font-brand type-money-hero">
      {label && <span className="sr-only">{label}</span>}
      <span aria-hidden={label ? true : undefined}>{children}</span>
    </p>
  );
}
