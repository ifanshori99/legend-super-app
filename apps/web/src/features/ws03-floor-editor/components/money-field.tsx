// Rupiah field: keeps digits only while typing and shows the grouped amount
// under the input, so a long minimum spend stays readable (DESIGN.md §3
// "Numbers"). The value is whole rupiah, like every amount in the contract.
import * as React from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { Input } from "@/components/ui/input";
import { formatRupiahInput, rupiahOf } from "../lib";

type Props = Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "inputMode"
> & {
  /** Whole rupiah. */
  value: number;
  onChange: (value: number) => void;
};

function MoneyField({ value, onChange, ...props }: Props) {
  return (
    <div className="grid gap-1">
      <Input
        {...props}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={formatRupiahInput(value)}
        onChange={(event) => onChange(rupiahOf(event.target.value))}
      />
      <p className="tabular text-xs leading-4 text-muted-foreground">
        {formatRupiah(value)}
      </p>
    </div>
  );
}

export { MoneyField };
