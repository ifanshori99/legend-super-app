import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { useMemberFavorites } from "../hooks";
import { FavoriteList } from "./favorite-list";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";

// PRD §3.20 "Halaman Member": favorit (menu most ordered, §3.21).
export function MemberFavoritesPage() {
  const t = useT();
  const query = useMemberFavorites();
  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.favorites.title")}
        intro={t("member.favorites.intro")}
      />
      {query.isPending ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState title={t("member.favorites.empty")} />
      ) : (
        <FavoriteList favorites={query.data} />
      )}
    </div>
  );
}
