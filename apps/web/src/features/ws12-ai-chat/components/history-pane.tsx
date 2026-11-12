// "Riwayat Anda": the person's own conversations (nobody else sees them) and
// "Percakapan baru". Desktop shows it as a column (list scrolls, "Hapus
// riwayat" stays at the bottom); phones open it in a sheet.
import { Plus, Trash2 } from "lucide-react";
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
  onDeleteAll,
  deleteDisabled,
  className,
}: {
  conversations: readonly AiConversation[];
  isPending: boolean;
  error: unknown;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  /** Opens the "Hapus riwayat" confirmation. */
  onDeleteAll: () => void;
  deleteDisabled: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full justify-start"
        onClick={onNew}
      >
        <Plus aria-hidden="true" />
        {t("aiChat.history.newConversation")}
      </Button>
      <h2 className="text-sm font-semibold text-muted-foreground">
        {t("aiChat.history.title")}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
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
      </div>
      <div className="grid gap-2 border-t-(length:--border-w) pt-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full justify-start"
          disabled={deleteDisabled}
          onClick={onDeleteAll}
        >
          <Trash2 aria-hidden="true" />
          {t("aiChat.deleteAll")}
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("aiChat.history.privacy")}
        </p>
      </div>
    </div>
  );
}
