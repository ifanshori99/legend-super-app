// Customer 360 (/kelola/pelanggan/$customerProfileId; PRD v1.7 §3.21
// "Customer 360": visit history, favorite items, spend, tier, points, reviews
// and preferences, according to the role's permissions). The profile row, tier
// progress, one metric strip, then the append-only point ledger last.
//
// PRD §2 privacy: the DTO drops the WhatsApp hash; birth day and referral code
// are masked unless the visitor holds `crm.customer.view`. The page guard
// already requires it, so the mask is defense in depth for a loosened guard.
import * as React from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProgressMeter } from "@/features/ws08-member/components/progress-meter";
import { useCustomer360, useCustomerPoints } from "../hooks";
import {
  feedbackKindKey,
  formatBirthMonthDay,
  formatDate,
  formatDateTime,
  percentFromBp,
  pointSourceKey,
  pointTypeKey,
  shortRef,
  signedPoints,
} from "../lib";
import { useCrm360T } from "../t";
import {
  CursorPager,
  FeedbackKindBadge,
  FeedbackStatusPill,
  MembershipStatusPill,
  ReadProblem,
} from "./crm-shell";

const POINTS_PAGE_SIZE = 10;

function BackLink() {
  const t = useCrm360T();
  return (
    <Link
      to="/kelola/pelanggan"
      className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("crm360.detail.back")}
    </Link>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <CardShell className="min-w-0">
      <CardShellBody>
        <header className="grid gap-1 px-card pt-card pb-3">
          <h3 className="type-title">{title}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        </header>
        <div className="min-w-0">{children}</div>
      </CardShellBody>
    </CardShell>
  );
}

function DetailSkeleton() {
  const common = useT();
  return (
    <div className="grid gap-5" aria-busy="true">
      <span className="sr-only">{common("common.loading")}</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40" />
      <Skeleton className="h-48" />
      <Skeleton className="h-56" />
    </div>
  );
}

export function CustomerDetailPage({
  customerProfileId,
}: {
  customerProfileId: string;
}) {
  const t = useCrm360T();
  const common = useT();
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  const canViewPii = holdsAny(access, ["crm.customer.view"]);

  const [pointCursors, setPointCursors] = React.useState<
    (string | undefined)[]
  >([undefined]);
  const pointCursor = pointCursors.at(-1);

  const customer = useCustomer360(customerProfileId);
  const points = useCustomerPoints(customerProfileId, {
    limit: POINTS_PAGE_SIZE,
    ...(pointCursor === undefined ? {} : { cursor: pointCursor }),
  });

  if (customer.isPending) return <DetailSkeleton />;

  if (customer.isError) {
    const error = customer.error;
    const notFound =
      error instanceof ApiError &&
      (error.status === 404 ||
        error.code === "NOT_FOUND" ||
        error.code === "VALIDATION_ERROR");
    return (
      <div className="grid gap-4">
        <BackLink />
        <CardShell>
          <CardShellBody>
            {notFound ? (
              <ErrorState
                title={t("crm360.detail.notFoundTitle")}
                description={t("crm360.detail.notFoundHint")}
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link to="/kelola/pelanggan">
                      {t("crm360.detail.back")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <ReadProblem
                error={error}
                title={t("crm360.detail.loadError")}
                hint={t("crm360.detail.loadHint")}
                offlineTitle={t("crm360.detail.offlineTitle")}
                offlineHint={t("crm360.detail.offlineHint")}
                onRetry={() => void customer.refetch()}
              />
            )}
          </CardShellBody>
        </CardShell>
      </div>
    );
  }

  const data = customer.data;
  const profile = data.profile;
  const visits = [...data.recentVisits].sort(
    (left, right) => Date.parse(right.visitedAt) - Date.parse(left.visitedAt),
  );
  const favorites = [...data.favoriteItems].sort(
    (left, right) => right.quantity - left.quantity,
  );
  const recentFeedback = [...data.recentFeedback].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const activeVoucherValue = data.activeVouchers.reduce(
    (total, voucher) => total + (voucher.valueIdr ?? 0),
    0,
  );
  const progressPercent = percentFromBp(data.tierProgressBp);
  const pointRows = points.data?.data ?? [];
  const nextPointCursor = points.data?.meta.nextCursor ?? null;

  const masked = t("crm360.pii.masked");
  const birthDate =
    profile.birthMonthDay === null
      ? t("crm360.detail.notSet")
      : canViewPii
        ? formatBirthMonthDay(profile.birthMonthDay)
        : masked;
  const referral =
    profile.referralCode === null
      ? t("crm360.detail.notSet")
      : canViewPii
        ? profile.referralCode
        : masked;

  return (
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">{profile.name}</h2>
          <MembershipStatusPill status={profile.membershipStatus} />
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("crm360.detail.memberSince", {
            date: formatDate(profile.createdAt),
          })}
          {" · "}
          {profile.lastVisitAt === null
            ? t("crm360.detail.neverVisited")
            : t("crm360.detail.lastVisit", {
                date: formatDate(profile.lastVisitAt),
              })}
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("crm360.detail.birthDate")}
            </dt>
            <dd className="font-medium">{birthDate}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("crm360.detail.referral")}
            </dt>
            <dd className="font-medium tabular">{referral}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {t("crm360.detail.whatsapp")}
            </dt>
            <dd className="font-medium">
              {profile.whatsappVerifiedAt === null
                ? t("crm360.detail.whatsappUnverified")
                : t("crm360.detail.whatsappVerified", {
                    date: formatDate(profile.whatsappVerifiedAt),
                  })}
            </dd>
          </div>
        </dl>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("crm360.pii.hint")}
        </p>
      </header>

      <CardShell>
        <CardShellBody>
          <div className="grid gap-3 p-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid gap-0.5">
                <p className="type-eyebrow text-muted-foreground">
                  {t("crm360.detail.tierCurrent")}
                </p>
                <p className="type-title">
                  {data.currentTier?.name ?? t("crm360.detail.tierNone")}
                </p>
              </div>
              {data.nextTier === null ? (
                <Badge tone="success">{t("crm360.detail.tierHighest")}</Badge>
              ) : (
                <Badge tone="brand">
                  {t("crm360.detail.progress", {
                    percent: progressPercent,
                    tier: data.nextTier.name,
                  })}
                </Badge>
              )}
            </div>
            <ProgressMeter
              value={data.tierProgressBp}
              max={10_000}
              label={
                data.nextTier === null
                  ? t("crm360.detail.tierHighest")
                  : t("crm360.detail.progress", {
                      percent: progressPercent,
                      tier: data.nextTier.name,
                    })
              }
            />
            <p className="text-sm leading-5 text-muted-foreground">
              {t("crm360.detail.progressHint")}
            </p>
            {data.nextTier !== null && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("crm360.detail.nextRequirement", {
                  tier: data.nextTier.name,
                  spend: formatRupiah(data.nextTier.thresholdSpendIdr),
                  visits: formatNumber(data.nextTier.thresholdVisits),
                })}
              </p>
            )}
          </div>
        </CardShellBody>
      </CardShell>

      <StatStrip
        label={t("crm360.detail.summaryLabel", { name: profile.name })}
      >
        <StatTile
          label={t("crm360.detail.stats.rollingSpend")}
          value={<Money amount={data.rollingSpendIdr} size="stat" />}
          context={t("crm360.detail.stats.rollingSpendContext")}
        />
        <StatTile
          label={t("crm360.detail.stats.rollingVisits")}
          value={<NumberDisplay value={data.rollingVisits} size="stat" />}
          context={t("crm360.detail.stats.rollingVisitsContext")}
        />
        <StatTile
          label={t("crm360.detail.stats.points")}
          value={<NumberDisplay value={profile.pointsBalance} size="stat" />}
          context={t("crm360.detail.stats.pointsContext")}
        />
        <StatTile
          label={t("crm360.detail.stats.vouchers")}
          value={
            <NumberDisplay value={data.activeVouchers.length} size="stat" />
          }
          context={
            activeVoucherValue > 0
              ? t("crm360.detail.stats.vouchersValue", {
                  value: formatRupiah(activeVoucherValue),
                })
              : t("crm360.detail.stats.vouchersContext", {
                  count: formatNumber(data.activeVouchers.length),
                })
          }
        />
      </StatStrip>

      <Section
        title={t("crm360.detail.visits.title")}
        description={t("crm360.detail.visits.description")}
      >
        {visits.length === 0 ? (
          <EmptyState
            title={t("crm360.detail.visits.emptyTitle")}
            description={t("crm360.detail.visits.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("crm360.detail.visits.columns.visitedAt")}
                </TableHead>
                <TableHead>
                  {t("crm360.detail.visits.columns.outlet")}
                </TableHead>
                <TableHead numeric>
                  {t("crm360.detail.visits.columns.items")}
                </TableHead>
                <TableHead numeric>
                  {t("crm360.detail.visits.columns.spend")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visits.map((visit) => (
                <TableRow key={visit.orderId}>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatDateTime(visit.visitedAt)}
                  </TableCell>
                  <TableCell title={visit.outletId}>
                    <span className="tabular">{shortRef(visit.outletId)}</span>
                  </TableCell>
                  <TableCell numeric>{formatNumber(visit.itemCount)}</TableCell>
                  <TableCell numeric>
                    <Money amount={visit.spendIdr} size="sm" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t("crm360.detail.favorites.title")}
        description={t("crm360.detail.favorites.description")}
      >
        {favorites.length === 0 ? (
          <EmptyState
            title={t("crm360.detail.favorites.emptyTitle")}
            description={t("crm360.detail.favorites.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("crm360.detail.favorites.columns.menu")}
                </TableHead>
                <TableHead numeric>
                  {t("crm360.detail.favorites.columns.quantity")}
                </TableHead>
                <TableHead>
                  {t("crm360.detail.favorites.columns.lastOrdered")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {favorites.map((item) => (
                <TableRow key={item.menuItemId}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell numeric>
                    {t("crm360.detail.favorites.quantity", {
                      count: formatNumber(item.quantity),
                    })}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatDate(item.lastOrderedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t("crm360.detail.feedback.title")}
        description={t("crm360.detail.feedback.description")}
      >
        {recentFeedback.length === 0 ? (
          <EmptyState
            title={t("crm360.detail.feedback.emptyTitle")}
            description={t("crm360.detail.feedback.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("crm360.feedback.columns.rating")}</TableHead>
                <TableHead>{t("crm360.feedback.columns.status")}</TableHead>
                <TableHead>{t("crm360.feedback.columns.comment")}</TableHead>
                <TableHead>{t("crm360.feedback.columns.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentFeedback.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <FeedbackKindBadge kind={entry.kind} />
                      {entry.kind === "rating" && entry.rating !== null && (
                        <span className="text-sm font-medium tabular">
                          {t("crm360.feedback.ratingLabel", {
                            rating: entry.rating,
                          })}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <FeedbackStatusPill status={entry.status} />
                  </TableCell>
                  <TableCell className="max-w-96">
                    <span className="block break-words">
                      {entry.comment ?? t("crm360.feedback.noComment")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(feedbackKindKey(entry.kind))}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatDateTime(entry.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t("crm360.detail.consents.title")}
        description={t("crm360.detail.consents.description")}
      >
        {data.consents.length === 0 ? (
          <EmptyState
            title={t("crm360.detail.consents.emptyTitle")}
            description={t("crm360.detail.consents.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("crm360.detail.consents.columns.purpose")}
                </TableHead>
                <TableHead>
                  {t("crm360.detail.consents.columns.policyVersion")}
                </TableHead>
                <TableHead>
                  {t("crm360.detail.consents.columns.grantedAt")}
                </TableHead>
                <TableHead>
                  {t("crm360.detail.consents.columns.status")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.consents.map((consent) => (
                <TableRow key={consent.id}>
                  <TableCell className="font-medium">
                    {t(`crm360.detail.consents.purposes.${consent.purpose}`)}
                  </TableCell>
                  <TableCell className="tabular">
                    {consent.policyVersion}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    {formatDate(consent.grantedAt)}
                  </TableCell>
                  <TableCell>
                    {consent.withdrawnAt === null ? (
                      <Badge tone="success">
                        {t("crm360.detail.consents.granted")}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        {t("crm360.detail.consents.withdrawn", {
                          date: formatDate(consent.withdrawnAt),
                        })}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title={t("crm360.detail.points.title")}
        description={t("crm360.detail.points.description")}
      >
        {points.isError && points.data === undefined ? (
          <ReadProblem
            error={points.error}
            title={t("crm360.detail.loadError")}
            hint={t("crm360.detail.loadHint")}
            offlineTitle={t("crm360.detail.offlineTitle")}
            offlineHint={t("crm360.detail.offlineHint")}
            onRetry={() => void points.refetch()}
          />
        ) : points.isPending ? (
          <div className="grid gap-2 p-card" aria-busy="true">
            <span className="sr-only">{common("common.loading")}</span>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-row" />
            ))}
          </div>
        ) : pointRows.length === 0 ? (
          <EmptyState
            title={t("crm360.detail.points.emptyTitle")}
            description={t("crm360.detail.points.emptyHint")}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("crm360.detail.points.columns.createdAt")}
                  </TableHead>
                  <TableHead>
                    {t("crm360.detail.points.columns.type")}
                  </TableHead>
                  <TableHead numeric>
                    {t("crm360.detail.points.columns.points")}
                  </TableHead>
                  <TableHead>
                    {t("crm360.detail.points.columns.source")}
                  </TableHead>
                  <TableHead>
                    {t("crm360.detail.points.columns.expires")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pointRows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap tabular">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {t(pointTypeKey(entry.type))}
                    </TableCell>
                    <TableCell numeric>
                      <span
                        className={
                          entry.points > 0 ? "text-success" : "text-foreground"
                        }
                      >
                        {signedPoints(entry.points)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block">
                        {t(pointSourceKey(entry.sourceType))}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular">
                        {t("crm360.detail.points.liability", {
                          value: formatRupiah(entry.liabilityIdr),
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular">
                      {entry.expiresAt === null
                        ? t("crm360.detail.points.noExpiry")
                        : formatDate(entry.expiresAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <CursorPager
              countLabel={t("crm360.detail.points.rowCount", {
                count: formatNumber(pointRows.length),
              })}
              canPrevious={pointCursors.length > 1}
              canNext={nextPointCursor !== null}
              pending={points.isFetching}
              onPrevious={() =>
                setPointCursors((current) => current.slice(0, -1))
              }
              onNext={() => {
                if (nextPointCursor === null) return;
                setPointCursors((current) => [...current, nextPointCursor]);
              }}
            />
          </>
        )}
      </Section>
    </div>
  );
}
