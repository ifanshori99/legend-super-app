import * as React from "react";
import { cn } from "cn";
import { Switch as SwitchPrimitive } from "radix-ui";

// Track is 1.8× the check size, so it scales with density like Checkbox.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[calc(var(--check-size)+0.25rem)] w-[calc(var(--check-size)*1.8+0.25rem)] shrink-0 items-center rounded-full border-(length:--border-w) border-input bg-muted p-px transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[calc(var(--check-size)-0.125rem)] rounded-full bg-foreground shadow-raised transition-transform duration-(--duration-fast) ease-standard data-[state=checked]:translate-x-[calc(var(--check-size)*0.8)] data-[state=checked]:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
