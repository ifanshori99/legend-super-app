import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { useMemberMissions } from "../hooks";
import { ListSkeleton } from "./list-skeleton";
import { MissionCard } from "./mission-card";
import { MemberPageHeader } from "./page-header";

// PRD §3.20 "Mission": behaviour missions and stamp cards with their progress.
export function MemberMissionsPage() {
  const t = useT();
  const query = useMemberMissions();
  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.missions.title")}
        intro={t("member.missions.intro")}
      />
      {query.isPending ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState title={t("member.missions.empty")} />
      ) : (
        <div className="grid gap-3">
          {query.data.map((item) => (
            <MissionCard key={item.mission.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
