import * as React from "react";
import { cn } from "cn";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useT } from "@/components/i18n";
import { usePortalContainer } from "@/components/theme-scope";

// Radix handles focus trap, Escape, and returning focus to the trigger.
// On phones the dialog docks to the bottom as a sheet so the actions stay in
// thumb reach; from `sm` up it is centered.
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
) {
  return <DialogPrimitive.Portal container={usePortalContainer()} {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function CloseButton({ className }: { className?: string }) {
  const t = useT();
  return (
    <DialogPrimitive.Close
      className={cn(
        "inline-grid size-control-sm shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <X className="size-icon" aria-hidden="true" />
      <span className="sr-only">{t("common.close")}</span>
    </DialogPrimitive.Close>
  );
}

type DialogContentProps = React.ComponentProps<
  typeof DialogPrimitive.Content
> & {
  hideClose?: boolean;
};

function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col gap-4 overflow-y-auto rounded-t-sheet border bg-card p-card pb-[max(var(--card-pad),env(safe-area-inset-bottom))] text-foreground shadow-overlay outline-none",
          "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-shell sm:pb-card",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && <CloseButton className="absolute top-3 right-3" />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-12", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("type-title", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-(length:--density-text) leading-6 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export type { DialogContentProps };
export {
  CloseButton as DialogCloseButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
