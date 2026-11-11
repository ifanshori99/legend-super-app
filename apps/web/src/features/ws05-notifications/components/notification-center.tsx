import { Inbox, SlidersHorizontal } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useUnreadNotificationCount } from "../hooks";
import { InboxPanel } from "./inbox-panel";
import { PreferencesPanel } from "./preferences-panel";

/** Notification center (PRD §3.15): inbox, preferences, web-push opt-in. */
export function NotificationCenter({
  initialTab = "inbox",
}: {
  initialTab?: "inbox" | "preferences";
}) {
  const t = useT();
  const unreadCount = useUnreadNotificationCount();
  const unread = unreadCount.data?.data.unread ?? 0;

  return (
    <section
      aria-labelledby="notification-title"
      className="grid grid-cols-[minmax(0,1fr)] gap-5"
    >
      <h2 id="notification-title" className="sr-only">
        {t("notification.title")}
      </h2>

      <Tabs key={initialTab} defaultValue={initialTab}>
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="inbox">
              <Inbox aria-hidden="true" />
              {t("notification.tabs.inbox")}
              {unread > 0 && (
                <>
                  <Badge tone="solid" aria-hidden="true">
                    {unread}
                  </Badge>
                  <span className="sr-only">
                    {t("notification.inbox.unreadCount", { count: unread })}
                  </span>
                </>
              )}
            </TabsTrigger>
            <TabsTrigger value="preferences">
              <SlidersHorizontal aria-hidden="true" />
              {t("notification.tabs.preferences")}
            </TabsTrigger>
          </TabsList>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <TabsContent value="inbox">
          <InboxPanel />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesPanel />
        </TabsContent>
      </Tabs>
    </section>
  );
}
