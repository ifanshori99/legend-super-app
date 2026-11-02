import { useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { MEMBER_PAGE_SIZE } from "../api";
import { useMemberVisits } from "../hooks";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";
import { VisitList } from "./visit-list";

// PRD §3.20 "Halaman Member": riwayat kunjungan.
export function MemberVisitsPage() {
  const t = useT();
  const [limit, setLimit] = useState(MEMBER_PAGE_SIZE);
  const query = useMemberVisits(limit);
  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.visits.title")}
        intro={t("member.visits.intro")}
      />
      {query.isPending ? (
        <ListSkeleton rows={4} />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState title={t("member.visits.empty")} />
      ) : (
        <>
          <VisitList visits={query.data.data} />
          {query.data.meta.nextCursor !== null && (
            <Button
              variant="outline"
              className="w-fit"
              loading={query.isFetching}
              onClick={() => setLimit((current) => current + MEMBER_PAGE_SIZE)}
            >
              {t("member.visits.loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
