import {
  Cake,
  CalendarCheck,
  ShowerHead,
  Sparkles,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { Translate } from "@starter/shared/i18n";
import type { MemberOverview, TierBenefits } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMultiplier, percentFromBp } from "../format";
import { ProgressMeter } from "./progress-meter";

function Benefit({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-sm leading-5">
      <Icon
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}

function benefitsList(benefits: TierBenefits, t: Translate) {
  const items: React.ReactNode[] = [
    <Benefit key="multiplier" icon={Sparkles}>
      {t("member.tier.benefitMultiplier", {
        multiplier: formatMultiplier(benefits.pointsMultiplierBp),
      })}
    </Benefit>,
  ];
  if (benefits.birthdayRewardPoints > 0)
    items.push(
      <Benefit key="birthday" icon={Cake}>
        {t("member.tier.benefitBirthday", {
          points: formatNumber(benefits.birthdayRewardPoints),
        })}
      </Benefit>,
    );
  if (benefits.reservationPriority)
    items.push(
      <Benefit key="priority" icon={CalendarCheck}>
        {t("member.tier.benefitPriority")}
      </Benefit>,
    );
  if (benefits.exclusivePromotions)
    items.push(
      <Benefit key="exclusive" icon={Tag}>
        {t("member.tier.benefitExclusive")}
      </Benefit>,
    );
  if (benefits.facilityFreeAccessQuota > 0)
    items.push(
      <Benefit key="facility" icon={ShowerHead}>
        {t("member.tier.benefitFacility", {
          count: formatNumber(benefits.facilityFreeAccessQuota),
        })}
      </Benefit>,
    );
  return items;
}

// Tier card (PRD §3.20 "Tier", DESIGN.md §4 "kartu tier member"): current tier,
// progress toward the next one using the rolling window stats from the
// overview, and the tier's benefits. Display only: the server evaluates tiers.
export function TierCard({ overview }: { overview: MemberOverview }) {
  const t = useT();
  const { currentTier, nextTier } = overview;
  if (!currentTier) {
    return (
      <Card className="gap-2">
        <p className="text-sm leading-5 font-medium text-muted-foreground">
          {t("member.tier.current")}
        </p>
        <p className="font-brand text-2xl leading-8 font-bold">
          {t("member.tier.none")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("member.tier.noneHint")}
        </p>
      </Card>
    );
  }

  const target = nextTier ?? currentTier;
  const percent = percentFromBp(overview.tierProgressBp);
  return (
    <Card className="gap-4 bg-brand-subtle">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("member.tier.current")}
          </p>
          <p className="font-brand text-2xl leading-8 font-bold">
            {currentTier.name}
          </p>
        </div>
        <Badge tone="brand">
          <Sparkles aria-hidden="true" />
          {nextTier
            ? t("member.tier.nextTier", { tier: nextTier.name })
            : t("member.tier.highest")}
        </Badge>
      </div>

      {nextTier && (
        <div className="grid gap-1.5">
          <ProgressMeter
            value={overview.tierProgressBp}
            max={10_000}
            label={t("member.tier.progress", {
              percent: formatNumber(percent),
              tier: nextTier.name,
            })}
          />
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("member.tier.progress", {
              percent: formatNumber(percent),
              tier: nextTier.name,
            })}
          </p>
        </div>
      )}

      <div className="grid gap-0.5 text-sm leading-5 text-muted-foreground">
        <p>
          {t("member.tier.spendProgress", {
            current: formatRupiah(overview.rollingSpendIdr),
            target: formatRupiah(target.thresholdSpendIdr),
          })}
        </p>
        <p>
          {t("member.tier.visitProgress", {
            current: formatNumber(overview.rollingVisits),
            target: formatNumber(target.thresholdVisits),
          })}
        </p>
      </div>

      <div className="grid gap-2">
        <p className="text-sm leading-5 font-semibold">
          {t("member.tier.benefits")}
        </p>
        <ul className="grid gap-1.5">
          {benefitsList(currentTier.benefits, t)}
        </ul>
      </div>
    </Card>
  );
}
