// One choice from 2–4 short options shown side by side (theme, density,
// view). A radio group underneath: arrow keys move, one tab stop.
// `selection="ink"` is for operations boards (DESIGN.md §2: filters and
// segmented controls select in ink, never the accent): on the dark kitchen
// ladder the page fill sits below the `surface-2` track, so the default
// page-fill selection would read as a hole instead of a raised choice.
// v3 (Metoric tab group): the default selection is a card chip with a
// hairline ring on the surface-2 track, the same look as Tabs.
// v4 (v4ht): optional `count` renders a tabular-nums chip after the label.
// The number is plain text inside the radio, so the accessible name reads
// "label count". The chip fill flips with the selection so the foreground
// number stays readable in checked and unchecked, light and dark.
import * as React from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";

type Option<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Optional count chip after the label. Undefined renders no chip. */
  count?: number;
  /** Not selectable (dimmed, skipped by the keyboard). */
  disabled?: boolean;
};

function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  selection = "page",
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly Option<T>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
  /** Fill of the checked item: the page fill (default) or ink for ops boards. */
  selection?: "page" | "ink";
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
      {options.map(
        ({
          value: optionValue,
          label: optionLabel,
          icon: Icon,
          count,
          disabled,
        }) => (
          <RadioGroup.Item
            key={optionValue}
            value={optionValue}
            disabled={disabled}
            className={cn(
              "group/seg disabled:pointer-events-none disabled:opacity-50 inline-flex min-h-[calc(var(--control-h-sm)-0.5rem)] shrink-0 items-center gap-1.5 rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground data-[state=checked]:font-semibold",
              selection === "ink"
                ? "data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=checked]:shadow-raised"
                : "data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)]",
            )}
          >
            {Icon && <Icon className="size-4" aria-hidden="true" />}
            {optionLabel}
            {count !== undefined && (
              <span
                className={cn(
                  "inline-flex min-w-6 items-center justify-center rounded-full px-1.5 text-sm leading-6 font-semibold text-foreground tabular-nums",
                  selection === "ink"
                    ? "bg-card group-data-[state=checked]/seg:bg-background"
                    : "bg-card group-data-[state=checked]/seg:bg-surface-2",
                )}
              >
                {count}
              </span>
            )}
          </RadioGroup.Item>
        ),
      )}
    </RadioGroup.Root>
  );
}

export { SegmentedControl };
