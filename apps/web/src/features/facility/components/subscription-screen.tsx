// Subscription page at `/member/fasilitas/langganan` (PRD §3 F22 "Langganan
// Bulanan", alur U). Shows the current plan and quota, the invoice that funds
// it, and pause/stop; without a subscription it offers the plans of the
// facility the guest came from.
//
// FAC-07 is visible here on purpose: a bill unpaid past its grace period says
// so, and the quota meter marks the quota unusable, so a guest learns it before
// walking to the door.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CreditCard, PauseCircle, PlayCircle, ReceiptText } from "lucide-react";
import type { PublicSubscriptionPlan } from "@starter/shared/facility";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { useToast } from "@/components/ui/toast";
import { formatClock, formatDateLabel } from "../flow";
import {
  useCurrentSubscription,
  useStartSubscription,
  useSubscriptionPlans,
  useUpdateSubscription,
} from "../hooks";
import { ApiFailure, LoadingCard, Section } from "./shared";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const STATUS_KEYS = {
  active: "facility.subscription.status.active",
  past_due: "facility.subscription.status.pastDue",
  suspended: "facility.subscription.status.suspended",
  paused: "facility.subscription.status.paused",
  cancelled: "facility.subscription.status.cancelled",
} as const;

const INVOICE_KEYS = {
  pending: "facility.subscription.invoiceStatus.pending",
  paid: "facility.subscription.invoiceStatus.paid",
  expired: "facility.subscription.invoiceStatus.expired",
  failed: "facility.subscription.invoiceStatus.failed",
  refunded: "facility.subscription.invoiceStatus.refunded",
} as const;

const INVOICE_TONES = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  failed: "danger",
  refunded: "neutral",
} as const;

function periodRange(start: string, end: string): string {
  return `${formatDateLabel(`${start}T00:00:00+07:00`)} – ${formatDateLabel(
    `${end}T00:00:00+07:00`,
  )}`;
}

export function FacilitySubscriptionScreen({
  facilityFromSearch,
}: {
  facilityFromSearch: string | undefined;
}) {
  const t = useT();
  const toast = useToast();
  const current = useCurrentSubscription();
  const facilityId =
    facilityFromSearch ?? current.data?.plan.facilityId ?? null;
  const plans = useSubscriptionPlans(facilityId);
  const start = useStartSubscription();
  const update = useUpdateSubscription();
  const [pendingPlan, setPendingPlan] = useState<PublicSubscriptionPlan | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<
    "pause" | "resume" | "cancel" | null
  >(null);

  const view = current.data ?? null;

  async function startPlan(plan: PublicSubscriptionPlan) {
    try {
      await start.mutateAsync({
        planId: plan.id,
        idempotencyKey: newIdempotencyKey(),
      });
      setPendingPlan(null);
      toast({ title: t("facility.subscription.started"), tone: "success" });
    } catch {
      // Rendered inside the dialog.
    }
  }

  async function runAction(action: "pause" | "resume" | "cancel") {
    if (!view) return;
    try {
      await update.mutateAsync({
        subscriptionId: view.subscription.id,
        body: { action },
      });
      setPendingAction(null);
      toast({ title: t("facility.subscription.updated"), tone: "success" });
    } catch {
      // Rendered inside the dialog.
    }
  }

  const actionCopy = {
    pause: {
      title: t("facility.subscription.pauseTitle"),
      body: t("facility.subscription.pauseBody"),
      confirm: t("facility.subscription.confirmPause"),
      variant: "default" as const,
    },
    resume: {
      title: t("facility.subscription.resume"),
      body: t("facility.subscription.resumeBody"),
      confirm: t("facility.subscription.confirmResume"),
      variant: "default" as const,
    },
    cancel: {
      title: t("facility.subscription.cancelTitle"),
      body: t("facility.subscription.cancelBody"),
      confirm: t("facility.subscription.confirmCancel"),
      variant: "destructive" as const,
    },
  };

  return (
    <div className="grid gap-6 pb-4">
      <header className="grid gap-1">
        <Link
          to="/member/fasilitas"
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          {t("facility.subscription.backToFacilities")}
        </Link>
        <h1 className="font-brand type-display-xl">
          {t("facility.subscription.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.subscription.intro")}
        </p>
      </header>

      {current.isPending ? (
        <LoadingCard lines={4} />
      ) : current.isError ? (
        <ErrorState onRetry={() => current.refetch()} />
      ) : view ? (
        <>
          <Section title={t("facility.subscription.currentTitle")}>
            <Card>
              <CardHeader>
                <CardTitle className="font-brand type-title">
                  {view.plan.name}
                </CardTitle>
                <CardDescription className="tabular">
                  {t("facility.subscription.period", {
                    start: formatDateLabel(
                      `${view.subscription.currentPeriodStart}T00:00:00+07:00`,
                    ),
                    end: formatDateLabel(
                      `${view.subscription.currentPeriodEnd}T00:00:00+07:00`,
                    ),
                  })}
                </CardDescription>
              </CardHeader>
              <div className="grid gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="type-eyebrow text-muted-foreground">
                    {t("facility.subscription.quotaLabel")}
                  </p>
                  <Badge
                    tone={
                      view.quota.reason === "ok"
                        ? "success"
                        : view.quota.usable
                          ? "warning"
                          : "danger"
                    }
                  >
                    {t(STATUS_KEYS[view.subscription.status])}
                  </Badge>
                </div>
                <p className="type-display tabular">
                  {t("facility.subscription.quotaValue", {
                    remaining: view.quota.remaining,
                  })}
                </p>
                <div
                  aria-hidden="true"
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (view.quota.used /
                            Math.max(1, view.quota.perPeriod)) *
                            100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("facility.list.quota", {
                    used: view.quota.used,
                    perPeriod: view.quota.perPeriod,
                  })}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t(`facility.subscription.reason.${view.quota.reason}`)}
                </p>
                {view.plan.maxPerDay !== null && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("facility.subscription.perDay", {
                      count: view.plan.maxPerDay,
                    })}
                  </p>
                )}
              </div>
              <CardFooter className="flex-wrap gap-2">
                {view.subscription.status === "paused" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingAction("resume")}
                  >
                    <PlayCircle aria-hidden="true" />
                    {t("facility.subscription.resume")}
                  </Button>
                ) : view.subscription.status === "active" ||
                  view.subscription.status === "past_due" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingAction("pause")}
                  >
                    <PauseCircle aria-hidden="true" />
                    {t("facility.subscription.pause")}
                  </Button>
                ) : null}
                {view.subscription.status !== "cancelled" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingAction("cancel")}
                  >
                    {t("facility.subscription.cancel")}
                  </Button>
                )}
              </CardFooter>
            </Card>
          </Section>

          <Section title={t("facility.subscription.invoices")}>
            {view.invoices.length === 0 ? (
              <EmptyState
                icon={ReceiptText}
                title={t("state.emptyTitle")}
                description={t("state.emptyHint")}
              />
            ) : (
              <ul className="divide-y divide-border rounded-container border-(length:--border-w) bg-card shadow-hairline">
                {view.invoices.map((invoice) => (
                  <li key={invoice.id} className="grid gap-1 px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm leading-5 font-medium tabular">
                        {periodRange(invoice.periodStart, invoice.periodEnd)}
                      </p>
                      <Badge tone={INVOICE_TONES[invoice.status]}>
                        {t(INVOICE_KEYS[invoice.status])}
                      </Badge>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <Money amount={invoice.amountIdr} size="md" />
                      {invoice.hostedUrl && invoice.status === "pending" ? (
                        <Button asChild variant="link" size="sm">
                          <a
                            href={invoice.hostedUrl}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            {t("facility.subscription.openInvoice")}
                          </a>
                        </Button>
                      ) : invoice.status === "pending" ? (
                        <span className="text-sm leading-5 text-muted-foreground">
                          {t("facility.subscription.invoiceLinkNote")}
                        </span>
                      ) : null}
                    </div>
                    {invoice.paidAt && (
                      <p className="text-sm leading-5 text-muted-foreground tabular">
                        {formatDateLabel(invoice.paidAt)}{" "}
                        {formatClock(invoice.paidAt)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : facilityId === null ? (
        <EmptyState
          icon={CreditCard}
          title={t("facility.subscription.noFacility")}
          description={t("facility.list.noSubscriptionHint")}
        />
      ) : plans.isPending ? (
        <LoadingCard lines={4} />
      ) : plans.isError ? (
        <ErrorState onRetry={() => plans.refetch()} />
      ) : (plans.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={CreditCard}
          title={t("facility.subscription.noPlans")}
          description={t("facility.subscription.noPlansHint")}
        />
      ) : (
        <Section title={t("facility.subscription.plans")}>
          <ul className="grid gap-3">
            {plans.data?.map((plan) => (
              <li key={plan.id}>
                <Card className="gap-3">
                  <CardHeader>
                    <CardTitle className="font-brand type-title">
                      {plan.name}
                    </CardTitle>
                    <CardDescription>
                      {t("facility.subscription.quotaPerPeriod", {
                        count: plan.quotaPerPeriod,
                      })}
                      {plan.maxPerDay !== null &&
                        ` · ${t("facility.subscription.perDay", {
                          count: plan.maxPerDay,
                        })}`}
                    </CardDescription>
                  </CardHeader>
                  <div className="flex items-baseline gap-1">
                    <Money amount={plan.priceIdr} size="stat" />
                    <span className="text-sm leading-5 text-muted-foreground">
                      {plan.interval === "month"
                        ? t("facility.subscription.perMonth")
                        : t("facility.subscription.perYear")}
                    </span>
                  </div>
                  <CardFooter>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPendingPlan(plan)}
                    >
                      {t("facility.subscription.choose")}
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Dialog
        open={pendingPlan !== null}
        onOpenChange={(open) => !open && setPendingPlan(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingPlan
                ? t("facility.subscription.startTitle", {
                    plan: pendingPlan.name,
                  })
                : ""}
            </DialogTitle>
            <DialogDescription>
              {pendingPlan &&
                t("facility.subscription.startBody", {
                  amount: formatRupiah(pendingPlan.priceIdr),
                  quota: pendingPlan.quotaPerPeriod,
                })}
            </DialogDescription>
          </DialogHeader>
          {start.isError && <ApiFailure error={start.error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button
              loading={start.isPending}
              onClick={() => pendingPlan && void startPlan(pendingPlan)}
            >
              {start.isPending
                ? t("facility.subscription.starting")
                : t("facility.subscription.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction ? actionCopy[pendingAction].title : ""}
            </DialogTitle>
            <DialogDescription>
              {pendingAction ? actionCopy[pendingAction].body : ""}
            </DialogDescription>
          </DialogHeader>
          {update.isError && <ApiFailure error={update.error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button
              variant={
                pendingAction ? actionCopy[pendingAction].variant : "default"
              }
              loading={update.isPending}
              onClick={() => pendingAction && void runAction(pendingAction)}
            >
              {pendingAction ? actionCopy[pendingAction].confirm : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
