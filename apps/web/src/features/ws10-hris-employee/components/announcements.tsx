// Announcements on the Beranda (PRD §3 Kelompok D 33 Beranda "pengumuman").
// Read-only here: acknowledging an announcement is its own screen (F29), so no
// dead action is offered.
import { Megaphone } from "lucide-react";
import { useT } from "@/components/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useAnnouncements } from "../hooks.ts";
import { formatDateShort } from "../state.ts";
import {
  InlineEmpty,
  SectionError,
  SectionSkeleton,
} from "./section-states.tsx";

export function Announcements({ timeZone }: { timeZone: string }) {
  const t = useT();
  const announcements = useAnnouncements();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("hris.home.announcementTitle")}</CardTitle>
      </CardHeader>
      {announcements.isPending ? (
        <SectionSkeleton rows={2} />
      ) : announcements.isError ? (
        <SectionError
          title={t("hris.state.announcementsError")}
          description={t("hris.state.retryHint")}
          onRetry={() => void announcements.refetch()}
        />
      ) : announcements.data.data.length === 0 ? (
        <InlineEmpty
          icon={Megaphone}
          title={t("hris.home.announcementEmpty")}
        />
      ) : (
        <ul className="divide-y">
          {announcements.data.data.map((announcement) => (
            <li key={announcement.id} className="grid gap-1 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm leading-5 font-medium">
                  {announcement.title}
                </p>
                <span className="shrink-0 text-xs leading-4 text-muted-foreground tabular">
                  {formatDateShort(announcement.publishedAt, timeZone)}
                </span>
              </div>
              <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
                {announcement.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
