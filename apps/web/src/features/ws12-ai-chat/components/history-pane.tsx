// "Riwayat Anda": the person's own conversations (nobody else sees them) and
// "Percakapan baru". Desktop shows it as a column; phones open it in a sheet.
import { Plus } from "lucide-react";
import type { AiConversation } from "@starter/shared/ai";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";

export function HistoryPane({
  conversations,
  isPending,
  error,
  activeId,
  onSelect,
  onNew,
  onRetry,
  className,
}: {
  conversations: readonly AiConversation[];
  isPending: boolean;
  error: unknown;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("grid content-start gap-3", className)}>
      <h2 className="text-base font-semibold">{t("aiChat.history.title")}</h2>
      {isPending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t("aiChat.history.loading")}
          className="grid gap-2"
        >
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : error ? (
        <ErrorState
          error={error}
          title={t("aiChat.history.errorTitle")}
          description={t("aiChat.history.errorHint")}
          onRetry={onRetry}
          className="px-0 py-4"
        />
      ) : conversations.length === 0 ? (
        <EmptyState
          title={t("aiChat.history.emptyTitle")}
          description={t("aiChat.history.emptyHint")}
          className="px-0 py-4"
        />
      ) : (
        <ul aria-label={t("aiChat.history.listLabel")} className="grid gap-1">
          {conversations.map((conversation) => {
            const active = conversation.id === activeId;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "min-h-11 w-full rounded-control px-2.5 py-2 text-start text-sm break-words transition-colors hover:bg-accent",
                    active && "bg-surface-3 font-semibold",
                  )}
                >
                  {conversation.title}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        {t("aiChat.history.privacy")}
      </p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        onClick={onNew}
      >
        <Plus aria-hidden="true" />
        {t("aiChat.history.newConversation")}
      </Button>
    </div>
  );
}
