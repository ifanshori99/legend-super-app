// Money and numbers with tabular figures, so columns of amounts line up.
// Formatting lives in @starter/shared/i18n (one home, deterministic id-ID).
import * as React from "react";
import { cn } from "cn";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";

type Size = "sm" | "md" | "lg" | "xl";
const SIZE: Record<Size, string> = {
  sm: "text-sm",
  md: "text-(length:--density-text)",
  lg: "text-xl font-semibold",
  xl: "text-3xl leading-tight font-semibold tracking-tight",
};

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
      {formatRupiah(amount)}
    </data>
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
