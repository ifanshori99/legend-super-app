import { useState } from "react";
import { CircleAlert, CircleCheck, RotateCw } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { Reward, RewardRedemption } from "@starter/shared/crm";
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
import { memberErrorKey } from "../errors";
import { useRedeemReward } from "../hooks";

type Phase = "confirm" | "success" | "error";

// LOY-03: redemption is atomic. The parent mints one idempotency key per
// attempt (and remounts this dialog per attempt), so a double tap or a retried
// request never spends points twice; the result (code, pending status) is
// final until the member closes the dialog.
export function RedeemDialog({
  reward,
  idempotencyKey,
  balance,
  open,
  onOpenChange,
}: {
  reward: Reward | null;
  idempotencyKey: string | null;
  balance: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const redeem = useRedeemReward();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [redemption, setRedemption] = useState<RewardRedemption | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (!reward || idempotencyKey === null) return null;
  const selected = reward;
  const key = idempotencyKey;
  const cost = selected.pointsCost;
  const remaining = Math.max(0, balance - cost);

  function confirm() {
    redeem.mutate(
      { rewardId: selected.id, idempotencyKey: key },
      {
        onSuccess: (result) => {
          setRedemption(result);
          setPhase("success");
        },
        onError: (failure) => {
          setError(failure);
          setPhase("error");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !redeem.isPending && onOpenChange(next)}
    >
      <DialogContent>
        {phase === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("member.rewards.dialogTitle", { reward: selected.name })}
              </DialogTitle>
              <DialogDescription>
                {t("member.rewards.dialogBody", {
                  points: formatNumber(cost),
                  balance: formatNumber(remaining),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={redeem.isPending}
              >
                {t("member.rewards.dialogCancel")}
              </Button>
              <Button onClick={confirm} loading={redeem.isPending}>
                {redeem.isPending
                  ? t("member.rewards.submitting")
                  : t("member.rewards.dialogConfirm")}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "success" && redemption && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheck
                  className="size-5 text-success"
                  aria-hidden="true"
                />
                {t("member.rewards.successTitle")}
              </DialogTitle>
              <DialogDescription>
                {t("member.rewards.successBody")}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1 rounded-lg bg-muted p-4 text-center">
              <p className="text-sm leading-5 font-medium text-muted-foreground">
                {t("member.rewards.successCode")}
              </p>
              <p className="font-mono text-2xl leading-8 font-bold tracking-widest tabular">
                {redemption.redemptionCode}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("member.rewards.successPending")}
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t("member.rewards.done")}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "error" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleAlert
                  className="size-5 text-danger"
                  aria-hidden="true"
                />
                {t("member.rewards.errorTitle")}
              </DialogTitle>
            </DialogHeader>
            <p role="alert" className="text-sm leading-5 text-danger">
              {t(memberErrorKey(error))}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("member.rewards.dialogCancel")}
              </Button>
              <Button onClick={confirm} loading={redeem.isPending}>
                <RotateCw aria-hidden="true" />
                {t("member.rewards.tryAgain")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
