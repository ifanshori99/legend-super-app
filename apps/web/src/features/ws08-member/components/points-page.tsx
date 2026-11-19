import { useState } from "react";
import { QrCode } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { MEMBER_PAGE_SIZE } from "../api";
import { useMemberOverview, useMemberPoints, useWhatsAppLink } from "../hooks";
import { LedgerList } from "./ledger-list";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";
import { PointsCard } from "./points-card";
import { QrTokenDialog } from "./qr-token-dialog";
import { WhatsAppLinkPrompt } from "./whatsapp-link-prompt";

// PRD §3.20 "Poin": the member's balance and the append-only ledger behind it.
export function MemberPointsPage() {
  const t = useT();
  const [limit, setLimit] = useState(MEMBER_PAGE_SIZE);
  const [qrOpen, setQrOpen] = useState(false);
  const overviewQuery = useMemberOverview();
  const pointsQuery = useMemberPoints(limit);
  const whatsApp = useWhatsAppLink();

  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.points.title")}
        intro={t("member.points.expiryHint", {
          months: overviewQuery.data?.program.expiryMonths ?? 12,
        })}
      />

      <WhatsAppLinkPrompt state={whatsApp} />

      {overviewQuery.isPending ? (
        <ListSkeleton rows={2} />
      ) : overviewQuery.isError ? (
        <ErrorState onRetry={() => overviewQuery.refetch()} />
      ) : (
        <PointsCard
          balance={overviewQuery.data.profile.pointsBalance}
          program={overviewQuery.data.program}
          showCta={false}
        />
      )}

      <QrTokenDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        trigger={
          <Button
            variant={whatsApp.status === "linked" ? "default" : "outline"}
            className="min-h-11 w-full sm:w-fit"
          >
            <QrCode aria-hidden="true" />
            {t("member.qr.open")}
          </Button>
        }
      />

      <section className="grid gap-3">
        <h2 className="font-brand type-title">
          {t("member.points.historyTitle")}
        </h2>
        {pointsQuery.isPending ? (
          <ListSkeleton rows={4} />
        ) : pointsQuery.isError ? (
          <ErrorState onRetry={() => pointsQuery.refetch()} />
        ) : pointsQuery.data.data.length === 0 ? (
          <EmptyState
            title={
              whatsApp.status === "unlinked"
                ? t("member.whatsapp.historyEmpty")
                : t("member.points.historyEmpty")
            }
          />
        ) : (
          <>
            <LedgerList entries={pointsQuery.data.data} />
            {pointsQuery.data.meta.nextCursor !== null && (
              <Button
                variant="outline"
                className="w-fit"
                loading={pointsQuery.isFetching}
                onClick={() =>
                  setLimit((current) => current + MEMBER_PAGE_SIZE)
                }
              >
                {t("member.points.loadMore")}
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
