import { useState } from "react";
import { formatNumber } from "@starter/shared/i18n";
import type { Reward } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { useMemberOverview, useMemberRewards } from "../hooks";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";
import { RedeemDialog } from "./redeem-dialog";
import { RewardCard } from "./reward-card";

type Attempt = { reward: Reward; idempotencyKey: string };

// PRD §3.20 "Reward Katalog": the catalog and the atomic redemption flow
// (LOY-03). The attempt (reward + idempotency key) is created when the member
// taps Tukar, so a retry inside the dialog reuses the same key.
export function MemberRewardsPage() {
  const t = useT();
  const overviewQuery = useMemberOverview();
  const rewardsQuery = useMemberRewards();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const balance = overviewQuery.data?.profile.pointsBalance ?? 0;

  function openRedeem(reward: Reward) {
    setAttempt({ reward, idempotencyKey: crypto.randomUUID() });
  }

  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.rewards.title")}
        intro={t("member.rewards.intro")}
      />

      {overviewQuery.isPending ? (
        <ListSkeleton rows={1} />
      ) : overviewQuery.isError ? (
        <ErrorState onRetry={() => overviewQuery.refetch()} />
      ) : (
        <p className="text-sm leading-5 font-medium text-muted-foreground">
          {t("member.rewards.balance", {
            points: formatNumber(overviewQuery.data.profile.pointsBalance),
          })}
        </p>
      )}

      {rewardsQuery.isPending ? (
        <ListSkeleton rows={3} />
      ) : rewardsQuery.isError ? (
        <ErrorState onRetry={() => rewardsQuery.refetch()} />
      ) : rewardsQuery.data.data.length === 0 ? (
        <EmptyState title={t("member.rewards.empty")} />
      ) : (
        <div className="grid gap-3">
          {rewardsQuery.data.data.map((reward) => (
            <RewardCard
              key={reward.id}
              reward={reward}
              balance={balance}
              onRedeem={openRedeem}
            />
          ))}
        </div>
      )}

      <RedeemDialog
        key={attempt?.idempotencyKey ?? "closed"}
        reward={attempt?.reward ?? null}
        idempotencyKey={attempt?.idempotencyKey ?? null}
        balance={balance}
        open={attempt !== null}
        onOpenChange={(open) => {
          if (!open) setAttempt(null);
        }}
      />
    </div>
  );
}
