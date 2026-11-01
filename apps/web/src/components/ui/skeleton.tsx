import * as React from "react";
import { cn } from "cn";

// Loading placeholder shaped like the content it replaces. Decorative:
// the region that is loading sets aria-busy and a text label for readers.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
