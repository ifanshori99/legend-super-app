import * as React from "react";
import { cn } from "cn";

/**
 * Shared field look: also used by Textarea and the Select trigger. v3
 * (Metoric search field): hairline shadow at rest; focus turns the edge
 * accent and adds a 3px accent halo instead of the offset outline. The
 * resting edge stays `input` (>= 3:1, WCAG 1.4.11; Legend wins over
 * Metoric's soft field border).
 */
export const fieldClass =
  "w-full min-w-0 rounded-field border-(length:--border-w) border-input bg-background text-(length:--density-text) text-foreground shadow-hairline transition-[border-color,box-shadow] duration-(--duration-fast) placeholder:text-muted-foreground focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-danger aria-invalid:border-2";

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
