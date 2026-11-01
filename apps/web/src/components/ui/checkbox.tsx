import * as React from "react";
import { cn } from "cn";
import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

// Pair with a <Label htmlFor>: the label is the touch target, the box only
// shows state. Box size follows density (16 / 20 / 28px).
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-check shrink-0 place-items-center rounded-xs border-(length:--border-w) border-input bg-background text-primary-foreground transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <Minus className="size-[80%]" strokeWidth={3} aria-hidden="true" />
        ) : (
          <Check className="size-[80%]" strokeWidth={3} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
