// Flag rekonsiliasi payout: the flags the payout reconciliation raised, and the
// two-person clearance that lifts the hold of one flag. The shell owns the h1.
// The list API has no batch filter, so the batch picker only narrows what the
// loaded flags show. Names and amounts come from the batch; nothing here pays.
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { API_MOCK } from "@/lib/api/mock-flag";
import { isPayoutOffline } from "../errors";
import type { PayoutAccess } from "../guard";
import { useActingUserId, usePayoutReconFlags } from "../hooks";
import { useReconFacts } from "./recon-facts";
import { ReconFlagList } from "./recon-list";
import {
  batchIdsOf,
  RECON_LIST_LIMIT,
  defaultFlagId,
  type ReconNotice,
} from "./recon-model";
import { ReconPanel } from "./recon-panel";
import {
  PanelSkeleton,
  PlaceholderScope,
  ReconSkeleton,
  ScopeCard,
} from "./recon-scope";

export function ReconPage({
  access,
  currentUserId,
}: {
  access: PayoutAccess;
  currentUserId: string;
}) {
  const t = useT();
  // The flags are only fetched for someone who may act on them.
  if (!access.canApprove)
    return (
      <EmptyState
        icon={ShieldCheck}
        title={t("payrollPayoutReview.recon.noAccess.title")}
        description={t("payrollPayoutReview.recon.noAccess.description")}
      />
    );
  return <ReconContent sessionUserId={currentUserId} />;
}

function ReconContent({ sessionUserId }: { sessionUserId: string }) {
  const currentUserId = useActingUserId(sessionUserId);
  const t = useT();
  const query = usePayoutReconFlags();

  if (query.isPending) return <ReconSkeleton />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <header className="flex flex-wrap items-center gap-2">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("payrollPayoutReview.recon.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </header>
      {query.isError ? (
        <>
          <PlaceholderScope kind="error" />
          <ErrorState
            title={t(
              isPayoutOffline(query.error)
                ? "payrollPayout.error.offlineTitle"
                : "payrollPayoutReview.recon.error.title",
            )}
            description={t("payrollPayoutReview.recon.error.description")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        </>
      ) : query.data.length === 0 ? (
        <>
          <PlaceholderScope kind="empty" />
          <EmptyState
            icon={ShieldCheck}
            title={t("payrollPayoutReview.recon.empty.title")}
            description={t("payrollPayoutReview.recon.empty.description")}
            action={
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                {t("payrollPayoutReview.recon.empty.action")}
              </Button>
            }
          />
        </>
      ) : (
        <ReconBoard flags={query.data} currentUserId={currentUserId} />
      )}
    </div>
  );
}

function ReconBoard({
  flags,
  currentUserId,
}: {
  flags: NonNullable<ReturnType<typeof usePayoutReconFlags>["data"]>;
  currentUserId: string;
}) {
  const batchIds = batchIdsOf(flags);
  const [pickedBatch, setPickedBatch] = React.useState<string | undefined>();
  // A batch id that the list no longer has falls back to the newest one.
  const batchId =
    batchIds.find((id) => id === pickedBatch) ?? batchIds[0] ?? undefined;
  const batchFlags = flags.filter((flag) => flag.batchId === batchId);
  // The cap counts the whole list, not the chosen batch.
  const truncated = flags.length >= RECON_LIST_LIMIT;
  const [pickedFlag, setPickedFlag] = React.useState<string | undefined>();
  const selected =
    batchFlags.find((flag) => flag.id === pickedFlag) ??
    batchFlags.find((flag) => flag.id === defaultFlagId(batchFlags));
  const [notice, setNotice] = React.useState<ReconNotice>(null);
  const facts = useReconFacts(batchId, currentUserId);
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Bumped when the panel heading should take focus (a flag was chosen, or a
  // write went through), so a screen reader hears the new context.
  const [focusKey, setFocusKey] = React.useState(0);

  const show = (next: ReconNotice) => {
    setNotice(next);
    if (next?.kind === "sent" || next?.kind === "approved")
      setFocusKey((key) => key + 1);
  };

  const select = (flagId: string) => {
    setPickedFlag(flagId);
    setNotice(null);
    setFocusKey((key) => key + 1);
    // One column on a phone: bring the panel into view after choosing.
    if (window.matchMedia("(max-width: 1023px)").matches)
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({ block: "start" }),
      );
  };

  return (
    <>
      <ScopeCard
        batchIds={batchIds}
        flags={flags}
        batchId={batchId}
        facts={facts}
        batchFlags={batchFlags}
        truncated={truncated}
        onBatch={(id) => {
          setPickedBatch(id);
          setPickedFlag(undefined);
          setNotice(null);
        }}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ReconFlagList
          flags={batchFlags}
          selectedId={selected?.id}
          facts={facts}
          truncated={truncated}
          onSelect={select}
        />
        <div ref={panelRef} className="min-w-0 scroll-mt-4">
          {selected && facts.batchState === "loading" && <PanelSkeleton />}
          {selected && facts.batchState !== "loading" && (
            <ReconPanel
              // A new flag starts with empty fields.
              key={selected.id}
              flag={selected}
              flags={batchFlags}
              facts={facts}
              currentUserId={currentUserId}
              notice={notice}
              focusKey={focusKey}
              onNotice={show}
              onSelect={select}
            />
          )}
        </div>
      </div>
    </>
  );
}
