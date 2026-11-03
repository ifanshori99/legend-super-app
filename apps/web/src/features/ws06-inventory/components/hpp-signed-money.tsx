// A signed rupiah figure for a variance: <Money> keeps the typographic minus
// for a negative value, and a positive value gets an explicit "+" so the sign
// is never inferred from the hue alone — DESIGN.md §2: a delta follows business
// meaning, not decoration.
import type { ComponentProps } from "react";
import { Money } from "@/components/ui/money";
import type { Idr } from "@starter/shared/core";

type MoneySize = ComponentProps<typeof Money>["size"];

export function SignedMoney({
  amount,
  size = "md",
}: {
  amount: Idr | number;
  size?: MoneySize;
}) {
  if (amount <= 0) return <Money amount={amount} size={size} />;
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span aria-hidden="true">+</span>
      <Money amount={amount} size={size} />
    </span>
  );
}
