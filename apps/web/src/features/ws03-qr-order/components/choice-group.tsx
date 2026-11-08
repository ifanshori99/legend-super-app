// A group of options with a min/max rule (variants, modifiers). Single choice
// is a row of pill radios (selected = warm fill, darker edge, rust dot);
// multiple choice is a list of checkbox rows with "+ Rp x" on the right. The
// whole pill/row is the touch target (44px+). Sold-out options stay visible
// but cannot be chosen (ORD-05).
import { useId } from "react";
import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/ui/money";

export type ChoiceOption = {
  id: string;
  name: string;
  /** Price shown beside the option; null hides it. */
  priceIdr: number | null;
  /** "plus" prefixes + (modifier); "absolute" shows the full price (variant). */
  priceMode?: "plus" | "absolute";
  soldOut?: boolean;
};

const FOCUS =
  "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground";
const PILL = `inline-flex min-h-11 cursor-pointer items-center gap-2.5 rounded-full border-(length:--border-w) bg-card px-4 py-2 text-base transition-colors duration-(--duration-fast) ${FOCUS}`;
const CHECK_ROW = `flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-qr-cta px-1 py-1.5 text-base ${FOCUS}`;

function OptionPrice({ option }: { option: ChoiceOption }) {
  const t = useT();
  if (option.soldOut)
    return <Badge tone="neutral">{t("qrMenu.sheet.modifierSoldOut")}</Badge>;
  if (option.priceIdr === null) return null;
  if (option.priceMode !== "absolute" && option.priceIdr === 0) return null;
  return (
    <span className="text-base text-muted-foreground">
      {option.priceMode === "absolute" ? null : "+ "}
      <Money amount={option.priceIdr} size="md" />
    </span>
  );
}

export function ChoiceGroup({
  name,
  options,
  selected,
  multiple,
  onToggle,
  invalid = false,
  describedBy,
}: {
  name: string;
  options: readonly ChoiceOption[];
  selected: readonly string[];
  multiple: boolean;
  onToggle: (optionId: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const baseId = useId();
  if (!multiple)
    return (
      <RadioGroup.Root
        aria-label={name}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={selected[0] ?? ""}
        onValueChange={onToggle}
        className="flex flex-wrap gap-2"
      >
        {options.map((option) => {
          const checked = selected.includes(option.id);
          const id = `${baseId}-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={id}
              className={cn(
                PILL,
                checked ? "border-foreground bg-qr-selection" : "border-input",
              )}
            >
              <RadioGroup.Item
                id={id}
                value={option.id}
                disabled={option.soldOut}
                className="grid size-5 shrink-0 place-items-center rounded-full border-2 border-input bg-card data-[state=checked]:border-primary"
              >
                <RadioGroup.Indicator className="size-2.5 rounded-full bg-primary" />
              </RadioGroup.Item>
              <span className="min-w-0 font-medium">{option.name}</span>
              <OptionPrice option={option} />
            </label>
          );
        })}
      </RadioGroup.Root>
    );
  return (
    <div
      role="group"
      aria-label={name}
      aria-describedby={describedBy}
      className="grid gap-0.5"
    >
      {options.map((option) => {
        const checked = selected.includes(option.id);
        const id = `${baseId}-${option.id}`;
        return (
          <label key={option.id} htmlFor={id} className={CHECK_ROW}>
            <Checkbox
              id={id}
              className="size-6! rounded-sm bg-card"
              checked={checked}
              disabled={option.soldOut}
              onCheckedChange={() => onToggle(option.id)}
            />
            <span className="min-w-0 flex-1 font-medium">{option.name}</span>
            <OptionPrice option={option} />
          </label>
        );
      })}
    </div>
  );
}
