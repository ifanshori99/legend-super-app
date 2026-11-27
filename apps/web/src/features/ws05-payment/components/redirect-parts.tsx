// Building blocks shared by the "membuka halaman pembayaran" screens and the
// return page `/bayar/kembali` (C2b, legend-osqou.4;
// design/mockups/c2b-tamu-bayar). They render inside the QR theme scope
// ([data-surface="qr"]) and need no table journey context, so the return page
// can use them for a table order and a payment link alike.
import type { ReactNode } from "react";
import { cn } from "cn";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";

export type PillTone = "wait" | "ok" | "bad" | "neutral";

const PILL_TONE: Record<PillTone, string> = {
  wait: "bg-warning-subtle text-foreground",
  ok: "bg-success-subtle text-success",
  bad: "bg-danger-subtle text-danger",
  neutral: "bg-qr-selection text-foreground",
};

export function StatusPill({
  tone,
  icon,
  children,
}: {
  tone: PillTone;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold [&_svg]:size-4 [&_svg]:shrink-0",
        PILL_TONE[tone],
      )}
    >
      {icon}
      {children}
    </p>
  );
}

/** Pill, heading and lead of a state. */
export function StateHeader({
  pill,
  title,
  lead,
  level = 2,
}: {
  pill: ReactNode;
  title: ReactNode;
  lead: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header className="grid justify-items-start gap-3">
      {pill}
      <Heading className="type-display-xl max-w-[18ch] text-balance">
        {title}
      </Heading>
      <p className="max-w-[36em] text-lg leading-7 text-muted-foreground">
        {lead}
      </p>
    </header>
  );
}

/** Solid paper with the amount and its rows (Metode, Pesanan, Tempat). */
export function AmountPaper({
  label,
  amountIdr,
  rows,
  muted = false,
}: {
  label: string;
  amountIdr: number;
  rows: readonly { label: string; value: ReactNode }[];
  muted?: boolean;
}) {
  return (
    <section className="grid gap-1 rounded-qr-media bg-card p-4 shadow-raised">
      <p className="type-eyebrow text-muted-foreground">{label}</p>
      <Money
        amount={amountIdr}
        size="xl"
        className={cn(
          "text-[2.25rem] leading-11 font-bold tracking-tight",
          muted && "text-muted-foreground",
        )}
      />
      {rows.length > 0 && (
        <dl className="mt-2 grid gap-1 border-t border-dashed border-input pt-2.5">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-3 text-sm leading-6"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 text-right font-semibold">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function AmountPaperSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-3 rounded-qr-media bg-card p-4 shadow-raised"
    >
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-10 w-3/5" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/6" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

/** Numbered steps (1, 2, 3) with a title and a hint each. */
export function NumberedSteps({
  steps,
}: {
  steps: readonly { title: string; hint: string }[];
}) {
  return (
    <ol className="grid gap-3">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-2.5 text-base leading-6">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full bg-qr-selection text-xs font-bold"
          >
            {index + 1}
          </span>
          <div>
            <strong className="font-semibold">{step.title}</strong>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
              {step.hint}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Callout({
  tone = "neutral",
  icon,
  title,
  children,
}: {
  tone?: "neutral" | "warn";
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-qr-media px-3.5 py-3 text-sm leading-5 [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:shrink-0",
        tone === "warn" ? "bg-warning-subtle" : "bg-qr-selection",
      )}
    >
      {icon}
      <div>
        <b className="block font-semibold">{title}</b>
        {children}
      </div>
    </div>
  );
}

/** Ring spinner; holds still when the guest asked for reduced motion. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-7 shrink-0 rounded-full border-3 border-input border-t-primary motion-safe:animate-spin",
        className,
      )}
    />
  );
}
