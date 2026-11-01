import * as React from "react";
import { cn } from "cn";
import { fieldClass } from "@/components/ui/input";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, "min-h-24 px-3 py-2.5 leading-6", className)}
      {...props}
    />
  );
}

export { Textarea };
