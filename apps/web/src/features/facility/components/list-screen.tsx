// "Fasilitas Saya" at `/member/fasilitas` (PRD §3 F22, alur T langkah 3): the
// customer's tickets and subscription in one place. Empty, loading and error
// states are explicit; the booking entry is the facility QR, so the page links
// back to it only when it knows which facility the guest used.
import { Link } from "@tanstack/react-router";
import { Ticket } from "lucide-react";
import type {
  AccessTicketView,
  FacilitySubscriptionView,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Link as RouterLink } from "@tanstack/react-router";
import {
  formatClock,
  formatDateLabel,
  isActiveTicket,
  sortTicketViews,
} from "../flow";
import { useCurrentSubscription, useFacilityOpen, useTickets } from "../hooks";
import { ApiFailure, LoadingCard, Section, TicketStatusPill } from "./shared";

function TicketCard({ view }: { view: AccessTicketView }) {
  const t = useT();
  const ticket = view.ticket;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="tabular">
          {t("facility.ticket.schedule", {
            date: formatDateLabel(ticket.slot.startsAt),
            from: formatClock(ticket.slot.startsAt),
            until: formatClock(ticket.slot.endsAt),
          })}
        </CardTitle>
        <CardDescription>
          <span className="inline-flex flex-wrap items-center gap-2">
            <TicketStatusPill status={ticket.status} />
            {ticket.addons.length > 0 && (
              <span>
                {t("facility.review.addons")}:{" "}
                {ticket.addons.map((addon) => addon.name).join(", ")}
              </span>
            )}
          </span>
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button asChild variant="outline" size="sm">
          <RouterLink
            to="/member/fasilitas/$ticketId"
            params={{ ticketId: ticket.id }}
          >
            {t("facility.list.openTicket")}
          </RouterLink>
        </Button>
      </CardFooter>
    </Card>
  );
}

function SubscriptionSummary({
  view,
}: {
  view: FacilitySubscriptionView | null | undefined;
}) {
  const t = useT();
  if (view === undefined) return <LoadingCard lines={2} />;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="font-brand type-title">
          {view ? view.plan.name : t("facility.list.noSubscription")}
        </CardTitle>
        <CardDescription className="tabular">
          {view
            ? t("facility.list.quota", {
                used: view.subscription.quotaUsed,
                perPeriod: view.subscription.quotaPerPeriod,
              })
            : t("facility.list.noSubscriptionHint")}
        </CardDescription>
      </CardHeader>
      {view && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t(`facility.subscription.reason.${view.quota.reason}`)}
        </p>
      )}
      <CardFooter className="flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <RouterLink
            to="/member/fasilitas/langganan"
            search={view ? { facility: view.plan.facilityId } : {}}
          >
            {view
              ? t("facility.list.viewSubscription")
              : t("facility.list.seePlans")}
          </RouterLink>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Facility the guest used last, for the "Pesan lagi" shortcut. */
function knownFacilityId(
  views: readonly AccessTicketView[] | undefined,
  subscription: FacilitySubscriptionView | null | undefined,
): string | null {
  return subscription?.plan.facilityId ?? views?.[0]?.ticket.facilityId ?? null;
}

export function FacilityListScreen() {
  const t = useT();
  const tickets = useTickets();
  const subscription = useCurrentSubscription();
  const facilityId = knownFacilityId(tickets.data?.data, subscription.data);
  // 1269 F0: no way back into a facility that takes no bookings.
  const { open: bookable } = useFacilityOpen(facilityId);

  const views = sortTicketViews(tickets.data?.data ?? []);
  const active = views.filter((view) => isActiveTicket(view.ticket.status));
  const history = views.filter((view) => !isActiveTicket(view.ticket.status));
  // One page-level error beats the same alert twice (both reads failed).
  const pageFailed = tickets.isError && subscription.isError;

  return (
    <div className="grid gap-6 pb-4">
      <header className="grid gap-1">
        <h1 className="font-brand type-display-xl">
          {t("facility.list.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.list.intro")}
        </p>
      </header>

      {pageFailed ? (
        <ErrorState
          onRetry={() => {
            void tickets.refetch();
            void subscription.refetch();
          }}
        />
      ) : (
        <>
          <Section title={t("facility.list.subscriptionLabel")}>
            {subscription.isError ? (
              <ApiFailure
                error={subscription.error}
                onRetry={() => subscription.refetch()}
              />
            ) : (
              <SubscriptionSummary view={subscription.data} />
            )}
          </Section>

          <Section title={t("facility.list.tickets")}>
            {tickets.isPending ? (
              <LoadingCard lines={3} />
            ) : tickets.isError ? (
              <ApiFailure
                error={tickets.error}
                onRetry={() => tickets.refetch()}
              />
            ) : views.length === 0 ? (
              <EmptyState
                icon={Ticket}
                title={t("facility.list.emptyTickets")}
                description={t("facility.list.emptyTicketsHint")}
              />
            ) : (
              <div className="grid gap-3">
                {active.length > 0 && (
                  <div className="grid gap-3">
                    <h3 className="type-eyebrow text-muted-foreground">
                      {t("facility.list.activeTicket")}
                    </h3>
                    {active.map((view) => (
                      <TicketCard key={view.ticket.id} view={view} />
                    ))}
                  </div>
                )}
                {history.length > 0 && (
                  <div className="grid gap-3">
                    <h3 className="type-eyebrow text-muted-foreground">
                      {t("facility.list.history")}
                    </h3>
                    {history.map((view) => (
                      <TicketCard key={view.ticket.id} view={view} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>

          {facilityId && bookable && (
            <Button asChild size="lg">
              <Link to="/f/$facility" params={{ facility: facilityId }}>
                {t("facility.list.bookAgain")}
              </Link>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
