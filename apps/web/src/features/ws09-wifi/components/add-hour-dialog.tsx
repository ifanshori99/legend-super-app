// "+1 jam": the reminder's action (PRD §4 Alur X step 4) opens the drinks
// menu. The menu is the QR-order screen of the guest's own table, so the CTA
// carries the table token the portal was opened from; from the Wi-Fi sticker
// (no token) the dialog explains where to scan instead of inventing a route.
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRupiah } from "@starter/shared/i18n";
import type { WifiPolicy } from "@starter/shared/facility";
import { formatMinutes } from "../state.ts";

export function AddHourDialog({
  policy,
  tableToken,
  open,
  onOpenChange,
}: {
  policy: WifiPolicy;
  tableToken: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("wifi.drinksTitle")}</DialogTitle>
          <DialogDescription>
            {t("wifi.drinksHint", {
              amount: formatRupiah(policy.spendPerExtraHourIdr),
              minutes: formatMinutes(policy.extraMinutes, t),
            })}
          </DialogDescription>
        </DialogHeader>
        {tableToken ? (
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t("wifi.drinksClose")}</Button>
            </DialogClose>
            <Button asChild>
              <Link to="/t/$token" params={{ token: tableToken }}>
                {t("wifi.drinksOpenMenu")}
              </Link>
            </Button>
          </DialogFooter>
        ) : (
          <>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("wifi.drinksNoTable")}
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("common.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
