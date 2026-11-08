import type { ReactNode } from "react";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { Money } from "@/components/ui/money";

// The centered result of a step: a round OK or fail mark (icon plus text, never
// color alone), a title, one sentence, an optional large amount, and a slot
// for what follows (references, buttons).
export function StateBlock({
  mark,
  title,
  description,
  amountIdr,
  children,
  className,
  ...props
}: {
  mark?: "ok" | "fail";
  title: string;
  description?: string;
  /** Whole rupiah, shown large under the sentence. */
  amountIdr?: number;
  children?: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"div">, "title" | "children">) {
  return (
    <div
      data-slot="state-block"
      data-mark={mark}
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-8 text-center",
        className,
      )}
      {...props}
    >
      {mark && (
        <span
          className={cn(
            "grid size-16 place-items-center rounded-full",
            mark === "ok"
              ? "bg-success-subtle text-success"
              : "bg-danger-subtle text-danger",
          )}
        >
          {mark === "ok" ? (
            <Check className="size-8" aria-hidden="true" />
          ) : (
            <X className="size-8" aria-hidden="true" />
          )}
        </span>
      )}
      <div className="grid max-w-md gap-1">
        <h2 className="type-title">{title}</h2>
        {description && (
          <p className="text-(length:--density-text) leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {amountIdr !== undefined && <Money amount={amountIdr} size="hero" />}
      {children}
    </div>
  );
}
