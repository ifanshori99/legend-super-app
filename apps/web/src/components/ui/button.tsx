import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { LoaderCircle, Lock } from "lucide-react";
import { Slot } from "radix-ui";
import {
  SUPPORT_READ_ONLY_HINT_ID,
  useNotifySupportReadOnlyBlocked,
  useSupportReadOnly,
} from "@/features/ws01-support-access/read-only";

// v3 (Metoric): primary = solid accent with a tinted hairline shadow;
// outline = card fill, soft border, hairline shadow (the label identifies
// the button, so its edge need not reach 3:1).
// Heights, padding, and corner shape come from the density layer
// (h-control, px-control-x, rounded-control), so one Button fits Hangat
// (pill CTA, 48px), Kontras (60px targets), and Padat (36px, 44px on touch).
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap pressable select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-icon",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-primary not-aria-disabled:hover:bg-primary-hover",
        brand:
          "bg-brand text-brand-foreground not-aria-disabled:hover:bg-brand/90",
        secondary:
          "bg-secondary text-foreground not-aria-disabled:hover:bg-accent",
        outline:
          "border-(length:--border-w) border-border bg-card text-foreground shadow-hairline not-aria-disabled:hover:bg-surface-2",
        ghost: "text-foreground not-aria-disabled:hover:bg-accent",
        destructive:
          "bg-danger text-danger-foreground not-aria-disabled:hover:bg-danger/90",
        link: "h-auto! px-0! text-primary underline underline-offset-4 not-aria-disabled:hover:decoration-2",
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
    /** Keeps a submit button enabled in a read-only support session. For
     * read-only forms (search/filter) only; pair with
     * `<form data-support-readonly-allow>`. */
    allowInReadOnly?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  allowInReadOnly = false,
  disabled,
  children,
  onClick,
  "aria-describedby": ariaDescribedBy,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  // A read-only support session cannot save: submit buttons are
  // aria-disabled (not `disabled`, so they stay focusable and explain why via
  // aria-describedby); the click is blocked here and the API refuses the write
  // anyway. Outside the provider this is false. `asChild` is unchanged.
  const supportReadOnly =
    useSupportReadOnly() &&
    !asChild &&
    props.type === "submit" &&
    !allowInReadOnly;
  const notifyBlocked = useNotifySupportReadOnlyBlocked();
  const describedBy = supportReadOnly
    ? [ariaDescribedBy, SUPPORT_READ_ONLY_HINT_ID].filter(Boolean).join(" ")
    : ariaDescribedBy;
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      // Spread before the read-only attributes so props cannot undo them.
      {...props}
      aria-disabled={supportReadOnly ? true : props["aria-disabled"]}
      aria-describedby={describedBy}
      onClick={
        supportReadOnly
          ? (event: React.MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              notifyBlocked();
            }
          : onClick
      }
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          )}
          {supportReadOnly && <Lock aria-hidden="true" />}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
