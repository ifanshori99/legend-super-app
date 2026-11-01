import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createTranslator } from "@starter/shared/i18n";
import { FacilityTicketScreen } from "@/features/facility/components/ticket-screen";
import { LoadingCard } from "@/features/facility/components/shared";
import { ErrorState } from "@/components/ui/feedback-state";
import { useT } from "@/components/i18n";
import { businessDateInOutletZone } from "@/features/facility/flow";
import { useTicket } from "@/features/facility/hooks";
import { availabilityQuery, ticketQuery } from "@/features/facility/queries";

// "/member/fasilitas/[ticketId]" — the access ticket: QR, PIN, session timer
// and the 5-minute reminder (PRD §3 F22 "Tiket Akses"/"Sesi & Pengingat",
// alur S langkah 5–7). The unit code and area name come from the availability
// of the ticket's own business date; the ticket view carries ids only.
const t = createTranslator();

export const Route = createFileRoute("/_customer/member/fasilitas/$ticketId")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("facility.ticket.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  // Prefetch the ticket and the availability that names its unit; a failure
  // stays in the cache and the screen renders its own ErrorState.
  loader: async ({ context, params }) => {
    const view = await context.queryClient
      .ensureQueryData(ticketQuery(params.ticketId))
      .catch(() => undefined);
    if (!view) return undefined;
    await context.queryClient
      .ensureQueryData(
        availabilityQuery(
          view.ticket.facilityId,
          businessDateInOutletZone(view.ticket.slot.startsAt),
        ),
      )
      .catch(() => undefined);
    return view;
  },
  component: TicketPage,
});

/** The page keeps its way back while the ticket itself cannot be read. */
function TicketError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="grid gap-4 pb-4">
      <Link
        to="/member/fasilitas"
        className="justify-self-start text-sm font-medium text-primary underline underline-offset-4"
      >
        {t("facility.ticket.backToList")}
      </Link>
      <ErrorState onRetry={onRetry} />
    </div>
  );
}

function TicketPage() {
  const { ticketId } = Route.useParams();
  const ticket = useTicket(ticketId);
  const date = ticket.data
    ? businessDateInOutletZone(ticket.data.ticket.slot.startsAt)
    : "";
  // Same query key as the loader, so the SSR cache is reused, not refetched.
  const availability = useQuery({
    ...availabilityQuery(ticket.data?.ticket.facilityId ?? "", date),
    enabled: Boolean(ticket.data),
  });

  if (ticket.isPending) return <LoadingCard lines={6} />;
  if (ticket.isError || !ticket.data)
    return <TicketError onRetry={() => ticket.refetch()} />;

  return (
    <FacilityTicketScreen view={ticket.data} availability={availability.data} />
  );
}
