import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { RESERVATION_STATUSES } from "@starter/shared/reservation";
import {
  ReservationsScreen,
  type ReservationTab,
} from "@/features/ws08-reservation/components/reservations-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/reservasi — the host stand (PRD v1.7 §5 "/pos/*", §3 F19 and §3.22
// "Reservasi & Event"). Guard is presentation only; the API re-checks every
// request. Search state is deep-linkable so the waitlist and a single
// reservation can be opened directly (also what the e2e spec drives).
const searchSchema = z.object({
  tab: z
    .enum(["schedule", "waitlist", "reschedule", "packages"])
    .catch("schedule")
    .default("schedule"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  status: z.enum(RESERVATION_STATUSES).optional().catch(undefined),
  reservationId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/pos/reservasi")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["reservation.view"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: ReservationsRoute,
});

function ReservationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReservationsScreen
      tab={search.tab}
      date={search.date}
      status={search.status}
      reservationId={search.reservationId}
      onTabChange={(tab: ReservationTab) =>
        void navigate({ search: (prev) => ({ ...prev, tab }) })
      }
      onDateChange={(date) =>
        void navigate({
          search: (prev) => ({ ...prev, date, reservationId: undefined }),
        })
      }
      onStatusChange={(status) =>
        void navigate({ search: (prev) => ({ ...prev, status }) })
      }
      onOpenReservation={(reservationId) =>
        void navigate({ search: (prev) => ({ ...prev, reservationId }) })
      }
      onCloseReservation={(options) =>
        void navigate({
          search: (prev) => ({ ...prev, reservationId: undefined }),
          replace: options?.replace,
        })
      }
    />
  );
}
