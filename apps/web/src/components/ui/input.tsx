import * as React from "react";
import { cn } from "cn";

/** Shared field look: also used by Textarea and the Select trigger. */
export const fieldClass =
  "w-full min-w-0 rounded-field border-(length:--border-w) border-input bg-background text-(length:--density-text) text-foreground transition-[border-color] duration-(--duration-fast) placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-danger aria-invalid:border-2";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        "h-control px-3 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
