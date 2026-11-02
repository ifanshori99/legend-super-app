import { useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@starter/shared/notification";
import { categoryLabelKey } from "../format";
import {
  useMarkAllNotificationsRead,
  useNotificationPages,
  useUnreadNotificationCount,
} from "../hooks";
import type { NotificationFilters } from "../queries";
import { NotificationRow } from "./notification-row";

const ALL_CATEGORIES = "all" as const;

/** In-app inbox (PRD §3.15: in-app is the official record). */
export function InboxPanel() {
  const t = useT();
  const toast = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | "all">(
    ALL_CATEGORIES,
  );

  const filters = useMemo<NotificationFilters>(
    () => ({
      unreadOnly,
      category: category === ALL_CATEGORIES ? null : category,
    }),
    [unreadOnly, category],
  );
  const pages = useNotificationPages(filters);
  const unreadCount = useUnreadNotificationCount();
  const markAll = useMarkAllNotificationsRead();
  const unread = unreadCount.data?.data.unread ?? 0;
  const filtered = unreadOnly || category !== ALL_CATEGORIES;

  const clearFilters = () => {
    setUnreadOnly(false);
    setCategory(ALL_CATEGORIES);
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {unreadCount.isPending ? (
          <Skeleton className="h-4 w-28" />
        ) : unreadCount.isError ? null : (
          <p className="text-sm leading-5 text-muted-foreground tabular">
            {unread > 0
              ? t("notification.inbox.unreadCount", { count: unread })
              : t("notification.inbox.allRead")}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={unread === 0}
          loading={markAll.isPending}
          onClick={() =>
            markAll.mutate(undefined, {
              onSuccess: (result) =>
                toast({
                  title: t("notification.inbox.markAllDone", {
                    count: result.data.updated,
                  }),
                  tone: "success",
                }),
            })
          }
        >
          {t("notification.inbox.markAllRead")}
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl<"all" | "unread">
          label={t("notification.inbox.filterLabel")}
          value={unreadOnly ? "unread" : "all"}
          onValueChange={(value) => setUnreadOnly(value === "unread")}
          options={[
            { value: "all", label: t("notification.inbox.filterAll") },
            { value: "unread", label: t("notification.inbox.filterUnread") },
          ]}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="notification-category" className="sr-only">
            {t("notification.inbox.categoryLabel")}
          </Label>
          <Select
            value={category}
            onValueChange={(value) =>
              setCategory(value as NotificationCategory | "all")
            }
          >
            <SelectTrigger
              id="notification-category"
              className="h-control-sm w-full sm:w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>
                {t("notification.inbox.categoryAll")}
              </SelectItem>
              {NOTIFICATION_CATEGORIES.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(categoryLabelKey(item))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {pages.isLoading ? (
        <div
          className="rounded-xl border-(length:--border-w) bg-card p-2"
          aria-busy="true"
        >
          <span className="sr-only">{t("common.loading")}</span>
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex items-start gap-3 border-t px-1 py-3 first:border-t-0"
            >
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="grid min-w-0 flex-1 gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full max-w-sm" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : pages.error ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <ErrorState
            title={t("notification.inbox.errorTitle")}
            description={t("notification.inbox.errorHint")}
            onRetry={() => void pages.refetch()}
          />
        </div>
      ) : pages.items.length === 0 ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            icon={Inbox}
            title={
              filtered
                ? t("notification.inbox.noResultsTitle")
                : t("notification.inbox.emptyTitle")
            }
            description={
              filtered
                ? t("notification.inbox.noResultsHint")
                : t("notification.inbox.emptyHint")
            }
            action={
              filtered ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {t("notification.inbox.filterAll")}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="rounded-xl border-(length:--border-w) bg-card px-1 py-1 sm:px-2">
          <ul aria-label={t("notification.inbox.heading")}>
            {pages.items.map((item) => (
              <NotificationRow key={item.id} item={item} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t px-1 py-3 sm:px-2">
            {pages.hasMore ? (
              <Button
                variant="outline"
                size="sm"
                loading={pages.isFetchingMore}
                onClick={pages.loadMore}
              >
                {t("notification.inbox.loadMore")}
              </Button>
            ) : (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("notification.inbox.allShown")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
