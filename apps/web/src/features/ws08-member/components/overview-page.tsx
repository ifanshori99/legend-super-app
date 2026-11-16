import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { activeConsentFor } from "../consent";
import {
  useMemberFavorites,
  useMemberMissions,
  useMemberOverview,
  useMemberRewards,
  useMemberVouchers,
  useMemberVisits,
  useWhatsAppLink,
} from "../hooks";
import { FavoriteList } from "./favorite-list";
import { ListSkeleton } from "./list-skeleton";
import { MissionCard } from "./mission-card";
import { MembershipStatusBadge } from "./status-badge";
import { PointsCard } from "./points-card";
import { SectionError } from "./section-error";
import { MemberSection } from "./section";
import { TierCard } from "./tier-card";
import { VisitList } from "./visit-list";
import { VoucherCard } from "./voucher-card";
import { WhatsAppLinkPrompt } from "./whatsapp-link-prompt";

// Member overview: PRD §3.20 "Halaman Member" puts balance, tier and progress,
// active missions, rewards, visits, vouchers and favorites in the customer
// PWA. Each block loads on its own so one slow list never hides the rest.
export function MemberOverviewPage() {
  const t = useT();
  const overviewQuery = useMemberOverview();
  const missionsQuery = useMemberMissions();
  const rewardsQuery = useMemberRewards();
  const vouchersQuery = useMemberVouchers();
  const visitsQuery = useMemberVisits(3);
  const favoritesQuery = useMemberFavorites();
  const whatsApp = useWhatsAppLink();

  if (overviewQuery.isPending)
    return <ListSkeleton rows={5} className="pt-2" />;
  if (overviewQuery.isError)
    return <ErrorState onRetry={() => overviewQuery.refetch()} />;

  const overview = overviewQuery.data;
  const loyaltyActive =
    activeConsentFor(overview.consents, "loyalty") !== undefined;
  const membershipActive =
    overview.profile.membershipStatus === "active" && loyaltyActive;
  const activeVouchers = (vouchersQuery.data?.data ?? []).filter(
    (voucher) => voucher.status === "issued",
  );

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="font-brand type-display-xl">
          {t("member.overview.greeting", { name: overview.profile.name })}
        </h1>
        <MembershipStatusBadge status={overview.profile.membershipStatus} />
      </header>

      <WhatsAppLinkPrompt state={whatsApp} />

      {!membershipActive && (
        <Card className="gap-2 bg-warning-subtle">
          <p className="text-sm leading-5 font-medium">
            {t("member.overview.membershipPending")}
          </p>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link to="/member/daftar">
              {t("member.overview.manageMembership")}
            </Link>
          </Button>
        </Card>
      )}

      <PointsCard
        balance={overview.profile.pointsBalance}
        program={overview.program}
      />

      {/* Design v3: the tier card is the one ink band on the page (ceremony). */}
      <ThemeScope mode="dark" className="rounded-container">
        <TierCard overview={overview} />
      </ThemeScope>

      <MemberSection
        title={t("member.overview.missionsTitle")}
        viewAllTo="/member/misi"
      >
        {missionsQuery.isPending ? (
          <ListSkeleton rows={2} />
        ) : missionsQuery.isError ? (
          <SectionError onRetry={() => missionsQuery.refetch()} />
        ) : missionsQuery.data.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.overview.missionsEmpty")}
          </p>
        ) : (
          <div className="grid gap-3">
            {missionsQuery.data.slice(0, 2).map((item) => (
              <MissionCard key={item.mission.id} item={item} />
            ))}
          </div>
        )}
      </MemberSection>

      <MemberSection
        title={t("member.overview.rewardsTitle")}
        viewAllTo="/member/reward"
      >
        {rewardsQuery.isPending ? (
          <ListSkeleton rows={2} />
        ) : rewardsQuery.isError ? (
          <SectionError onRetry={() => rewardsQuery.refetch()} />
        ) : rewardsQuery.data.data.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.rewards.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
            {rewardsQuery.data.data.slice(0, 3).map((reward) => (
              <li
                key={reward.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-(length:--density-text) leading-6 font-medium">
                    {reward.name}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t(`member.rewards.type.${reward.type}`)}
                  </p>
                </div>
                <p className="shrink-0 text-sm leading-5 font-semibold whitespace-nowrap">
                  {t("member.rewards.cost", {
                    points: formatNumber(reward.pointsCost),
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </MemberSection>

      <MemberSection
        title={t("member.overview.vouchersTitle")}
        viewAllTo="/member/voucher"
      >
        {vouchersQuery.isPending ? (
          <ListSkeleton rows={1} />
        ) : vouchersQuery.isError ? (
          <SectionError onRetry={() => vouchersQuery.refetch()} />
        ) : activeVouchers.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.vouchers.emptyActive")}
          </p>
        ) : (
          <div className="grid gap-3">
            {activeVouchers.slice(0, 2).map((voucher) => (
              <VoucherCard key={voucher.id} voucher={voucher} />
            ))}
          </div>
        )}
      </MemberSection>

      <MemberSection
        title={t("member.overview.visitsTitle")}
        viewAllTo="/member/kunjungan"
      >
        {visitsQuery.isPending ? (
          <ListSkeleton rows={2} />
        ) : visitsQuery.isError ? (
          <SectionError onRetry={() => visitsQuery.refetch()} />
        ) : visitsQuery.data.data.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.overview.visitsEmpty")}
          </p>
        ) : (
          <VisitList visits={visitsQuery.data.data} />
        )}
      </MemberSection>

      <MemberSection
        title={t("member.overview.favoritesTitle")}
        viewAllTo="/member/favorit"
      >
        {favoritesQuery.isPending ? (
          <ListSkeleton rows={2} />
        ) : favoritesQuery.isError ? (
          <SectionError onRetry={() => favoritesQuery.refetch()} />
        ) : favoritesQuery.data.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.overview.favoritesEmpty")}
          </p>
        ) : (
          <FavoriteList favorites={favoritesQuery.data.slice(0, 3)} />
        )}
      </MemberSection>

      <Card className="gap-2">
        <h2 className="type-heading">{t("member.overview.membershipTitle")}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {membershipActive
            ? t("member.overview.membershipActive")
            : t("member.overview.membershipPending")}
        </p>
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link to="/member/daftar">
            {t("member.overview.manageMembership")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </Card>
    </div>
  );
}
