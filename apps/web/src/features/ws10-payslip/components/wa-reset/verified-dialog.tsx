// "Nomor berhasil diverifikasi" (mockup terverifikasi). Shown only once the
// server reports the WhatsApp message as verified, including when the message
// arrived while the employee was inside WhatsApp. It has one way on and cannot
// be dismissed by Escape or an outside click, so the success is never missed
// and never skipped past the new-PIN form.
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type WaResetVerifiedDialogProps = {
  open: boolean;
  onContinue: () => void;
};

function WaResetVerifiedDialog({
  open,
  onContinue,
}: WaResetVerifiedDialogProps) {
  return (
    <Dialog open={open}>
      <DialogContent
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-start pr-0">
          <CircleCheck className="size-10 text-primary" aria-hidden="true" />
          <DialogTitle>Nomor berhasil diverifikasi</DialogTitle>
          <DialogDescription>
            Sekarang buat PIN slip gaji yang baru.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" size="lg" className="w-full" onClick={onContinue}>
            Buat PIN baru
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { WaResetVerifiedDialog };
export type { WaResetVerifiedDialogProps };
