// A group of options with a min/max rule (variants, modifiers). Single choice
// uses a radio group, multiple choice uses checkboxes; the row is the touch
// target (48px+). Sold-out options stay visible but cannot be chosen (ORD-05).
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

const ROW =
  "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-container border-(length:--border-w) bg-card px-3 py-2 text-left transition-colors duration-(--duration-fast) has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring";

function OptionPrice({ option }: { option: ChoiceOption }) {
  const t = useT();
  if (option.soldOut)
    return <Badge tone="neutral">{t("qrMenu.sheet.modifierSoldOut")}</Badge>;
  if (option.priceIdr === null) return null;
  if (option.priceMode !== "absolute" && option.priceIdr === 0) return null;
  return (
    <span className="text-sm text-muted-foreground">
      {option.priceMode === "absolute" ? null : "+"}
      <Money amount={option.priceIdr} size="sm" />
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
        className="grid gap-2"
      >
        {options.map((option) => {
          const checked = selected.includes(option.id);
          const id = `${baseId}-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={id}
              className={cn(
                ROW,
                checked ? "border-primary bg-primary-tint" : "border-border",
                invalid && !checked && "border-danger",
              )}
            >
              <RadioGroup.Item
                id={id}
                value={option.id}
                disabled={option.soldOut}
                className="grid size-check shrink-0 place-items-center rounded-full border-(length:--border-w) border-input bg-background data-[state=checked]:border-primary data-[state=checked]:bg-primary"
              >
                <RadioGroup.Indicator className="size-[40%] rounded-full bg-primary-foreground" />
              </RadioGroup.Item>
              <span className="min-w-0 flex-1 font-medium">{option.name}</span>
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
      className="grid gap-2"
    >
      {options.map((option) => {
        const checked = selected.includes(option.id);
        const id = `${baseId}-${option.id}`;
        return (
          <label
            key={option.id}
            htmlFor={id}
            className={cn(
              ROW,
              checked ? "border-primary bg-primary-tint" : "border-border",
            )}
          >
            <Checkbox
              id={id}
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
