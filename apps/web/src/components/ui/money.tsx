// Money and numbers with tabular figures, so columns of amounts line up.
// Formatting lives in @starter/shared/i18n (one home, deterministic id-ID).
import * as React from "react";
import { cn } from "cn";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";

type Size = "sm" | "md" | "lg" | "xl" | "stat" | "hero";
const SIZE: Record<Size, string> = {
  sm: "text-sm",
  md: "text-(length:--density-text)",
  lg: "text-xl font-semibold",
  xl: "text-3xl leading-tight font-semibold tracking-tight",
  // v2 money tiers (DESIGN.md §3): the currency prefix drops to 0.6em and
  // the hint color so the figure carries the weight.
  stat: "type-money-display",
  hero: "type-money-hero",
};
const SCALED: ReadonlySet<Size> = new Set(["stat", "hero"]);
const RUPIAH = /^(−?)(Rp)(.+)$/;

function Money({
  amount,
  size = "md",
  className,
  ...props
}: Omit<React.ComponentProps<"data">, "value"> & {
  /** Whole rupiah. */
  amount: number | bigint;
  size?: Size;
}) {
  return (
    <data
      value={String(amount)}
      className={cn("tabular whitespace-nowrap", SIZE[size], className)}
      {...props}
    >
      {SCALED.has(size) ? (
        <ScaledRupiah text={formatRupiah(amount)} />
      ) : (
        formatRupiah(amount)
      )}
    </data>
  );
}

function ScaledRupiah({ text }: { text: string }) {
  const match = RUPIAH.exec(text);
  if (!match) return <>{text}</>;
  const [, minus, currency, figure] = match;
  return (
    <>
      {minus}
      <span className="mr-[0.18em] align-[0.32em] text-[0.6em] font-medium tracking-normal text-muted-foreground">
        {currency}
      </span>
      {figure}
    </>
  );
}

function NumberDisplay({
  value,
  fractionDigits,
  size = "md",
  className,
  ...props
}: Omit<React.ComponentProps<"data">, "value"> & {
  value: number | bigint;
  fractionDigits?: number;
  size?: Size;
}) {
  return (
    <data
      value={String(value)}
      className={cn("tabular whitespace-nowrap", SIZE[size], className)}
      {...props}
    >
      {formatNumber(value, { fractionDigits })}
    </data>
  );
}

export { Money, NumberDisplay };
