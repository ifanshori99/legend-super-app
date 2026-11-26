import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
/**
 * O4 (bead legend-wasr7.8, mockup "keluar"): the sign-out refusal while
 * offline sales are still on this tablet. The queue lives on the cashier
 * screen, so the way on is to open it there.
 */
export function SignOutBlockedDialog({
  unsent,
  onClose,
  onOpenCashier,
}: {
  unsent: number;
  onClose: () => void;
  onOpenCashier: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={unsent > 0} onOpenChange={(open) => !open && onClose()}>
      <DialogContent role="alertdialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("posOffline.signOutTitle")}</DialogTitle>
          <DialogDescription>
            {t("posOffline.signOutBlocked", { count: unsent })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("posOffline.signOutRisk")}
        </p>
        <DialogFooter className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" size="lg" onClick={onClose}>
            {t("posOffline.signOutStay")}
          </Button>
          <Button type="button" size="lg" onClick={onOpenCashier}>
            {t("posOffline.signOutOpenCashier")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
