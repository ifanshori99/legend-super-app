// One choice from 2–4 short options shown side by side (theme, density,
// view). A radio group underneath: arrow keys move, one tab stop.
import * as React from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";

type Option<T extends string> = { value: T; label: string; icon?: LucideIcon };

function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly Option<T>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      aria-label={label}
      orientation="horizontal"
      className={cn(
        "inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-control border-(length:--border-w) bg-surface-2 p-1",
        className,
      )}
    >
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon }) => (
        <RadioGroup.Item
          key={optionValue}
          value={optionValue}
          className="inline-flex min-h-[calc(var(--control-h-sm)-0.5rem)] shrink-0 items-center gap-1.5 rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground data-[state=checked]:bg-card data-[state=checked]:font-semibold data-[state=checked]:text-foreground data-[state=checked]:shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)]"
        >
          {Icon && <Icon className="size-4" aria-hidden="true" />}
          {optionLabel}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export { SegmentedControl };
