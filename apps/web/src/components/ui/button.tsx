import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";

// v3 (Metoric): primary = solid accent with a tinted hairline shadow;
// outline = card fill, soft border, hairline shadow (the label identifies
// the button, so its edge need not reach 3:1).
// Heights, padding, and corner shape come from the density layer
// (h-control, px-control-x, rounded-control), so one Button fits Hangat
// (pill CTA, 48px), Kontras (60px targets), and Padat (36px, 44px on touch).
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap pressable select-none disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-icon",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-primary hover:bg-primary-hover",
        brand: "bg-brand text-brand-foreground hover:bg-brand/90",
        secondary: "bg-secondary text-foreground hover:bg-accent",
        outline:
          "border-(length:--border-w) border-border bg-card text-foreground shadow-hairline hover:bg-surface-2",
        ghost: "text-foreground hover:bg-accent",
        destructive: "bg-danger text-danger-foreground hover:bg-danger/90",
        link: "h-auto! px-0! text-primary underline underline-offset-4 hover:decoration-2",
      },
      size: {
        default: "h-control px-control-x text-(length:--density-text)",
        sm: "h-control-sm px-4 text-sm",
        lg: "h-control-lg px-8 text-(length:--density-text)",
        icon: "size-control",
        "icon-sm": "size-control-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a spinner, keeps the label, and blocks repeat presses. */
    loading?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          )}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
