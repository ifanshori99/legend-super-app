import * as React from "react";
import {
  Dialog,
  DialogContent,
  type DialogContentProps,
} from "@/components/ui/dialog";
import {
  blockWhilePending,
  guardOpenChange,
} from "@/components/ui/pending-dialog-logic";

// A Dialog that refuses to close while `pending` (Esc, outside click, X).
// Swap Dialog/DialogContent for PendingDialog/PendingDialogContent on any
// dialog that submits a request.
const PendingContext = React.createContext(false);

function PendingDialog({
  pending,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof Dialog> & { pending: boolean }) {
  return (
    <PendingContext.Provider value={pending}>
      <Dialog
        {...props}
        onOpenChange={guardOpenChange(pending, onOpenChange)}
      />
    </PendingContext.Provider>
  );
}

function PendingDialogContent({
  hideClose,
  onEscapeKeyDown,
  onInteractOutside,
  ...props
}: DialogContentProps) {
  const pending = React.useContext(PendingContext);
  return (
    <DialogContent
      {...props}
      hideClose={pending || hideClose}
      onEscapeKeyDown={blockWhilePending(pending, onEscapeKeyDown)}
      onInteractOutside={blockWhilePending(pending, onInteractOutside)}
    />
  );
}

export { PendingDialog, PendingDialogContent };
