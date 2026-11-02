import { Gift, PackageX, Ticket, TriangleAlert } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { Reward } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMemberDate } from "../format";

export type RewardAvailability = "available" | "insufficient" | "out_of_stock";

/**
 * Why a reward cannot be redeemed; validity dates are enforced by the API and
 * the mock (rewardRedemptionCheck), so the card only needs balance and stock.
 */
export function rewardAvailability(
  reward: Reward,
  balance: number,
): RewardAvailability {
  if (reward.stock !== null && reward.stock <= 0) return "out_of_stock";
  if (reward.pointsCost > balance) return "insufficient";
  return "available";
}

// One catalog entry (PRD §3.20 "Reward Katalog"). The button carries the
// reason it is disabled in text, never color alone; the dialog owns the
// atomic confirmation (LOY-03).
export function RewardCard({
  reward,
  balance,
  onRedeem,
}: {
  reward: Reward;
  balance: number;
  onRedeem: (reward: Reward) => void;
}) {
  const t = useT();
  const availability = rewardAvailability(reward, balance);
  const missing = Math.max(0, reward.pointsCost - balance);
  const TypeIcon = reward.type === "voucher" ? Ticket : Gift;

  const reason =
    availability === "insufficient" ? (
      <p className="text-sm leading-5 font-medium text-warning">
        <TriangleAlert
          className="mr-1 inline size-4 align-[-2px]"
          aria-hidden="true"
        />
        {t("member.rewards.insufficient", {
          points: formatNumber(missing),
        })}
      </p>
    ) : availability === "out_of_stock" ? (
      <p className="text-sm leading-5 font-medium text-warning">
        <PackageX
          className="mr-1 inline size-4 align-[-2px]"
          aria-hidden="true"
        />
        {t("member.rewards.outOfStock")}
      </p>
    ) : null;

  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <Badge tone="neutral">
            <TypeIcon aria-hidden="true" />
            {t(`member.rewards.type.${reward.type}`)}
          </Badge>
          <h3 className="type-heading">{reward.name}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {reward.description}
          </p>
        </div>
        <p className="tabular type-heading shrink-0 whitespace-nowrap">
          {t("member.rewards.cost", {
            points: formatNumber(reward.pointsCost),
          })}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm leading-5 text-muted-foreground">
          {reward.stock === null
            ? t("member.rewards.unlimited")
            : t("member.rewards.stock", {
                count: formatNumber(reward.stock),
              })}
          {reward.validUntil !== null && (
            <>
              {" · "}
              {t("member.vouchers.validUntil", {
                date: formatMemberDate(reward.validUntil),
              })}
            </>
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={availability !== "available"}
          onClick={() => onRedeem(reward)}
        >
          {t("member.rewards.redeem")}
        </Button>
      </div>
      {reason}
    </Card>
  );
}
