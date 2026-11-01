import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Dialog as SheetPrimitive } from "radix-ui";
import {
  DialogCloseButton,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";

// A side panel built on the same Radix Dialog (same focus and Escape rules).
// Used for the management nav on phones, filters, and cart review.
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-card p-card text-foreground shadow-overlay outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-(--duration-slow) data-[state=closed]:duration-(--duration-base)",
  {
    variants: {
      side: {
        right:
          "inset-y-0 right-0 w-[min(24rem,calc(100%-3rem))] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        left: "inset-y-0 left-0 w-[min(20rem,calc(100%-3rem))] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        bottom:
          "inset-x-0 bottom-0 max-h-[90dvh] rounded-t-2xl border-t pb-[max(var(--card-pad),env(safe-area-inset-bottom))] data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  },
);

function SheetContent({
  className,
  children,
  side,
  hideClose = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & { hideClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {!hideClose && <DialogCloseButton className="absolute top-3 right-3" />}
      </SheetPrimitive.Content>
    </DialogPortal>
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  DialogDescription as SheetDescription,
  DialogFooter as SheetFooter,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
  SheetTrigger,
};
