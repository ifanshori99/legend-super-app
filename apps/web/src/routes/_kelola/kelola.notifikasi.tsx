import { createFileRoute } from "@tanstack/react-router";
import { NotificationCenter } from "@/features/ws05-notifications/components/notification-center";
import { notificationsPageQuery } from "@/features/ws05-notifications/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// Notification center (PRD §3.15) in the management area: inbox, preferences
// and this device's web-push opt-in. The layout runs the area guard.
export const Route = createFileRoute("/_kelola/kelola/notifikasi")({
  // Mock mode serves the clickable demo: let the browser fetch so ?mock=empty
  // and ?mock=error apply instead of hydrating the server's fixture render.
  loader: ({ context }) =>
    API_MOCK
      ? undefined
      : context.queryClient.ensureQueryData(
          notificationsPageQuery({ unreadOnly: false, category: null }),
        ),
  component: NotificationCenter,
});
