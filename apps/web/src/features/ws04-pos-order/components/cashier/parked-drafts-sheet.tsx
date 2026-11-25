import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useParkedDrafts,
  useResumeDraft,
} from "@/features/ws04-pos-order/hooks";
import type { ParkedDraft, SaleChannel } from "@/features/ws04-pos-order/types";

const CHANNEL_KEY = {
  dine_in: "posOrderCart.channel.dineIn",
  takeaway: "posOrderCart.channel.takeaway",
  ojol_manual: "posOrderCart.channel.ojol",
} as const satisfies Record<SaleChannel, string>;

const timeFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
});

// Drafts the cashier parked ("Tahan pesanan"). Resuming removes the draft from
// the list and hands its lines back to the screen, which adds them to the cart.
export function ParkedDraftsSheet({
  open,
  onOpenChange,
  onResumed,
  draftKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The cashier's cart the resumed lines go into. */
  draftKey: string;
  onResumed: (draft: ParkedDraft & { missing?: number }) => void;
}) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-density="kontras"
        className="w-[min(26rem,100%)]"
      >
        <SheetHeader>
          <SheetTitle>{t("posOrderCart.parkedSheet.title")}</SheetTitle>
          <SheetDescription>
            {t("posOrderCart.parkedSheet.description")}
          </SheetDescription>
        </SheetHeader>
        {open && <ParkedList onResumed={onResumed} draftKey={draftKey} />}
      </SheetContent>
    </Sheet>
  );
}

// Only mounted while the sheet is open, so the list is fetched on demand.
function ParkedList({
  onResumed,
  draftKey,
}: {
  draftKey: string;
  onResumed: (draft: ParkedDraft & { missing?: number }) => void;
}) {
  const t = useT();
  const drafts = useParkedDrafts();
  const resume = useResumeDraft({ draftKey });

  if (drafts.isPending) {
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only">{t("posOrderCart.parkedSheet.loading")}</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-container" />
        ))}
      </div>
    );
  }

  if (!drafts.data) {
    const pending = isContractPending(drafts.error);
    return (
      <div className="grid gap-3">
        <Notice
          tone="danger"
          title={
            pending
              ? t("posOrderCart.error.pendingTitle")
              : t("posOrderCart.parkedSheet.error")
          }
        />
        {!pending && (
          <Button
            type="button"
            variant="outline"
            onClick={() => drafts.refetch()}
          >
            {t("posOrderCart.error.retry")}
          </Button>
        )}
      </div>
    );
  }

  if (drafts.data.length === 0) {
    return (
      <Notice tone="info" title={t("posOrderCart.parkedSheet.emptyTitle")}>
        {t("posOrderCart.parkedSheet.emptyDescription")}
      </Notice>
    );
  }

  return (
    <div className="grid gap-3">
      {drafts.isError && (
        <Notice
          tone="warning"
          title={t("posOrderCart.parkedSheet.refreshFailed")}
        />
      )}
      {resume.isError && (
        <Notice
          tone="danger"
          title={
            isContractPending(resume.error)
              ? t("posOrderCart.error.pendingTitle")
              : t("posOrderCart.error.resumeTitle")
          }
        >
          {!isContractPending(resume.error) &&
            t("posOrderCart.error.resumeBody")}
        </Notice>
      )}
      <ul className="grid gap-2">
        {drafts.data.map((draft) => {
          const itemCount = draft.lines.reduce(
            (sum, line) => sum + line.quantity,
            0,
          );
          const resuming =
            resume.isPending && resume.variables?.id === draft.id;
          return (
            <li
              key={draft.id}
              className="grid gap-2 rounded-container border-(length:--border-w) border-border bg-card p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 font-semibold break-words">
                  {draft.label}
                </p>
                <Money amount={draft.subtotalIdr} className="font-semibold" />
              </div>
              <p className="text-sm text-muted-foreground">
                {t("posOrderCart.parkedSheet.meta", {
                  count: itemCount,
                  channel: t(CHANNEL_KEY[draft.channel]),
                  time: timeFormat.format(new Date(draft.parkedAt)),
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                loading={resuming}
                aria-label={t("posOrderCart.parkedSheet.resumeLabel", {
                  label: draft.label,
                })}
                aria-disabled={resume.isPending && !resuming ? true : undefined}
                onClick={() => {
                  if (resume.isPending) return;
                  resume.mutate(
                    { id: draft.id },
                    {
                      onSuccess: (resumed) => {
                        if (resumed) onResumed(resumed);
                      },
                    },
                  );
                }}
              >
                {t("posOrderCart.parkedSheet.resume")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
