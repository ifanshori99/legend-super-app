import { Link } from "@tanstack/react-router";
import { CircleDot, Check } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import type { Notification } from "@starter/shared/notification";
import {
  categoryLabelKey,
  formatNotificationTime,
  NOTIFICATION_CATEGORY_ICONS,
} from "../format";
import { useMarkNotificationRead } from "../hooks";

/** One inbox row: category, title, body, time, and the unread action. */
export function NotificationRow({ item }: { item: Notification }) {
  const t = useT();
  const markRead = useMarkNotificationRead();
  const Icon = NOTIFICATION_CATEGORY_ICONS[item.category];
  const unread = item.readAt === null;
  const time = formatNotificationTime(item.createdAt);

  return (
    <li
      data-unread={unread || undefined}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-t px-1 py-3 first:border-t-0 sm:px-2",
        unread && "bg-info-subtle/40",
      )}
    >
      <span
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>

      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {unread && (
            <Badge tone="info">
              <CircleDot aria-hidden="true" />
              {t("notification.inbox.unread")}
            </Badge>
          )}
          <span className="inline-flex items-center gap-1 text-xs leading-4 font-medium text-muted-foreground">
            {t(categoryLabelKey(item.category))}
          </span>
          <time
            dateTime={item.createdAt}
            className="text-xs leading-4 text-muted-foreground tabular"
          >
            {time}
          </time>
        </div>
        {item.link ? (
          <Link
            to={item.link}
            onClick={() => {
              if (unread) markRead.mutate(item.id);
            }}
            className="w-fit rounded-xs text-left font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {item.title}
          </Link>
        ) : (
          <p className={cn("font-semibold", !unread && "font-medium")}>
            {item.title}
          </p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">{item.body}</p>
        {markRead.isError && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {t("notification.inbox.markReadError")}
          </p>
        )}
      </div>

      <div className="shrink-0">
        {unread && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("notification.inbox.markRead")}
            onClick={() => markRead.mutate(item.id)}
            loading={markRead.isPending && markRead.variables === item.id}
          >
            <Check aria-hidden="true" />
          </Button>
        )}
      </div>
    </li>
  );
}
