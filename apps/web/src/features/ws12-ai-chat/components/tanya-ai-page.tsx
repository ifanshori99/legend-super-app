// Tanya AI chat (PRD §3 Fitur 38, legend-mlnu). One page for every area that
// holds `ai.ask`; the area only changes the links (reports, drafts). The
// person's own history sits on the left (a sheet on phones), the chat in a
// centred column with the question box pinned below; answers are
// sourced, labelled "Dibantu AI", type in progressively, and can be stopped.
import * as React from "react";
import { History, Plus, RotateCw } from "lucide-react";
import type { AiConversationId, AiMessage } from "@starter/shared/ai";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { AREAS } from "@/lib/areas/definitions";
import { useOnline } from "@/lib/use-online";
import {
  useAskQuestion,
  useAiUsage,
  useConversation,
  useConversations,
} from "../hooks";
import {
  CHAT_FEATURE,
  chatBlock,
  classifyAskError,
  featureQuota,
  isNetworkError,
  visibleMessages,
  type ChatArea,
} from "../logic";
import { useProgressiveReveal } from "../use-progressive-reveal";
import { AnswerWithSource } from "./answer-with-source";
import { AskBanner, type BannerKind } from "./ask-banner";
import { ChatSuggestions } from "./chat-suggestions";
import { Composer } from "./composer";
import { DeleteHistoryDialog } from "./delete-history-dialog";
import { HistoryPane } from "./history-pane";

/** `"new"` = a blank conversation; `null` = follow the newest one. */
type Selection = string | "new" | null;
type Failure = {
  question: string;
  kind: BannerKind;
  conversationId: string | null;
};

function QuestionBubble({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <p className="ms-10 w-fit max-w-full justify-self-end rounded-container bg-surface-3 px-4 py-3 font-semibold break-words">
      <span className="sr-only">{t("aiChat.answer.questionPrefix")} </span>
      {children}
    </p>
  );
}

function ConversationSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("aiChat.chat.loading")}
      className="grid gap-5"
    >
      <Skeleton className="ms-12 h-12 justify-self-end" />
      <div className="grid gap-2.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}

export function TanyaAiPage({ area }: { area: ChatArea }) {
  const t = useT();
  const online = useOnline();
  const Heading = AREAS[area].shell === "management" ? "h2" : "h1";
  // No heading level skipped: the conversation title sits one level below.
  const TitleHeading = Heading === "h1" ? "h2" : "h3";

  const history = useConversations();
  const conversations = React.useMemo(
    () => history.data?.data ?? [],
    [history.data],
  );
  const [selection, setSelection] = React.useState<Selection>(null);
  const activeId =
    selection === "new" ? null : (selection ?? conversations[0]?.id ?? null);
  const detail = useConversation(activeId);
  const usage = useAiUsage();
  const ask = useAskQuestion();

  const [input, setInput] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, readonly string[]>>(
    {},
  );
  const [revealKey, setRevealKey] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const controller = React.useRef<AbortController | null>(null);
  const composerRef = React.useRef<HTMLInputElement>(null);

  const messages = React.useMemo(
    () => visibleMessages(detail.data?.data.messages ?? []),
    [detail.data],
  );
  const revealing = messages.find((m) => m.id === revealKey) ?? null;
  const reveal = useProgressiveReveal(
    revealing?.content ?? null,
    revealing ? revealKey : null,
  );

  const block = chatBlock(usage.data?.data);
  const quota = featureQuota(usage.data?.data);
  const bannerKind: BannerKind | null = failure
    ? failure.kind
    : !online
      ? "offline"
      : block;
  // The question stays "pending" until its answer is in the conversation, so
  // the screen never shows a gap between the spinner and the answer.
  const answered =
    revealKey !== null && messages.some((m) => m.id === revealKey);
  const asking = pending !== null && !answered;
  const busy = asking || reveal.running;
  const paused =
    !online ||
    block === "quota" ||
    block === "budget" ||
    block === "featureOff";

  function submit(
    question: string,
    conversationId: string | null,
    { keepInput = false }: { keepInput?: boolean } = {},
  ) {
    const trimmed = question.trim();
    if (!trimmed) return;
    setFailure(null);
    setPending(trimmed);
    // "Tanya ulang" resends an old question: the draft in the composer stays.
    if (!keepInput) setInput("");
    setRevealKey(null);
    const abort = new AbortController();
    controller.current = abort;
    ask.mutate(
      {
        body: {
          feature: CHAT_FEATURE,
          question: trimmed,
          ...(conversationId
            ? { conversationId: conversationId as AiConversationId }
            : {}),
        },
        signal: abort.signal,
      },
      {
        onSuccess: ({ data }) => {
          setSelection(data.conversation.id);
          setDrafts((current) => ({
            ...current,
            [data.assistantMessage.id]: data.actionRequestIds,
          }));
          setRevealKey(data.assistantMessage.id);
        },
        onError: (error) => {
          setPending(null);
          const kind: BannerKind = abort.signal.aborted
            ? "stopped"
            : isNetworkError(error)
              ? "offline"
              : classifyAskError(error);
          setFailure({ question: trimmed, kind, conversationId });
          // Let the person edit and resend (e.g. after a personal-data refusal).
          // Never overwrite a draft they typed meanwhile or kept on "Tanya ulang".
          if (!keepInput)
            setInput((current) => (current === "" ? trimmed : current));
        },
      },
    );
  }

  // "Tanya ulang": the last answer is in and nothing else is going on.
  const lastMessage = messages[messages.length - 1];
  const lastQuestion =
    lastMessage?.role === "assistant"
      ? messages
          .slice(0, -1)
          .reverse()
          .find((m) => m.role === "user")?.content
      : undefined;
  const canAskAgain =
    lastQuestion !== undefined &&
    !busy &&
    !failure &&
    !reveal.stopped &&
    !paused;

  function stop() {
    if (asking) controller.current?.abort();
    else reveal.stop();
  }

  function select(id: string | "new") {
    setSelection(id);
    setFailure(null);
    setPending(null);
    setRevealKey(null);
    setHistoryOpen(false);
  }

  const historyPane = (className?: string) => (
    <HistoryPane
      className={className}
      conversations={conversations}
      isPending={history.isPending}
      error={history.isError ? history.error : null}
      activeId={activeId}
      onSelect={select}
      onNew={() => select("new")}
      onRetry={() => void history.refetch()}
      onDeleteAll={() => {
        // Close the phone history sheet first so the delete dialog never
        // stacks on top of it (Radix leaves body pointer-events locked).
        setHistoryOpen(false);
        setDeleteOpen(true);
      }}
      deleteDisabled={history.isPending || conversations.length === 0}
    />
  );

  const title =
    detail.data?.data.conversation.title ?? t("aiChat.history.untitled");
  const notFound =
    detail.error instanceof ApiError && detail.error.status === 404;

  const management = AREAS[area].shell === "management";
  const showGreeting = messages.length === 0 && !asking && !failure;

  return (
    <section
      aria-labelledby="tanya-ai-title"
      className={cn(
        "@container relative flex min-h-(--chat-h) min-w-0 flex-col gap-3",
        management
          ? "[--chat-h:calc(100dvh-7rem)]"
          : "[--chat-h:calc(100dvh-6rem)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading id="tanya-ai-title" className="type-title">
          {t("aiChat.title")}
        </Heading>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        <p className="sr-only">{t("aiChat.subtitle")}</p>
        <div className="flex w-full flex-wrap gap-2 @2xl:hidden">
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-auto! min-h-11 max-w-full whitespace-normal"
              >
                <History aria-hidden="true" />
                {t("aiChat.history.openSheet")}
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle className="sr-only">
                  {t("aiChat.history.title")}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  {t("aiChat.history.privacy")}
                </SheetDescription>
              </SheetHeader>
              {historyPane("flex-1")}
            </SheetContent>
          </Sheet>
          <Button
            type="button"
            variant="outline"
            className="h-auto! min-h-11 max-w-full whitespace-normal"
            onClick={() => select("new")}
          >
            <Plus aria-hidden="true" />
            {t("aiChat.history.newConversation")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-6 @2xl:grid @2xl:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden @2xl:block">
          <div className="sticky top-0 h-[calc(var(--chat-h)-3rem)] border-e-(length:--border-w) pe-4">
            {historyPane("h-full")}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <TitleHeading className="sr-only">{title}</TitleHeading>
          <div
            className={cn(
              "mx-auto grid w-full max-w-[42rem] flex-1 gap-6 pb-4",
              showGreeting ? "content-center" : "content-start",
            )}
          >
            {detail.isPending && activeId !== null ? (
              <ConversationSkeleton />
            ) : history.isPending && selection === null ? (
              <ConversationSkeleton />
            ) : detail.isError ? (
              <ErrorState
                error={detail.error}
                title={
                  notFound
                    ? t("aiChat.chat.notFoundTitle")
                    : t("aiChat.chat.errorTitle")
                }
                description={
                  notFound
                    ? t("aiChat.chat.notFoundHint")
                    : t("aiChat.chat.errorHint")
                }
                onRetry={notFound ? undefined : () => void detail.refetch()}
                action={
                  notFound ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => select("new")}
                    >
                      {t("aiChat.history.newConversation")}
                    </Button>
                  ) : undefined
                }
              />
            ) : showGreeting ? (
              <div className="grid justify-items-center gap-5 py-8 text-center">
                <div className="grid gap-1.5">
                  <p className="type-title">{t("aiChat.empty.greeting")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("aiChat.chat.emptyHint")}
                  </p>
                </div>
                <ChatSuggestions
                  area={area}
                  disabled={paused}
                  onPick={(question) => {
                    // Keep any typed draft and move focus off the chip that
                    // unmounts once the question is asked.
                    submit(question, activeId, { keepInput: true });
                    composerRef.current?.focus();
                  }}
                />
              </div>
            ) : (
              <>
                {messages.map((message: AiMessage) =>
                  message.role === "user" ? (
                    <QuestionBubble key={message.id}>
                      {message.content}
                    </QuestionBubble>
                  ) : message.id === revealKey ? (
                    <AnswerWithSource
                      key={message.id}
                      area={area}
                      content={message.content.slice(0, reveal.shown)}
                      sources={message.sources}
                      busy={reveal.running}
                      ready={!reveal.running && !reveal.stopped}
                      showSources={!reveal.running && !reveal.stopped}
                      actionRequestIds={drafts[message.id] ?? []}
                    />
                  ) : (
                    <AnswerWithSource
                      key={message.id}
                      area={area}
                      content={message.content}
                      sources={message.sources}
                      actionRequestIds={drafts[message.id] ?? []}
                    />
                  ),
                )}
                {canAskAgain && (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => {
                        submit(lastQuestion, activeId, { keepInput: true });
                        // The button unmounts while busy: keep keyboard focus.
                        composerRef.current?.focus();
                      }}
                    >
                      <RotateCw aria-hidden="true" />
                      {t("aiChat.answer.askAgain")}
                    </Button>
                  </div>
                )}
                {reveal.stopped && (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <p className="font-semibold">
                      {t("aiChat.answer.stopped")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={reveal.showAll}
                    >
                      {t("aiChat.answer.showAll")}
                    </Button>
                  </div>
                )}
                {(asking || failure) && (
                  <QuestionBubble>
                    {pending ?? failure?.question}
                  </QuestionBubble>
                )}
                {asking && (
                  <div
                    role="status"
                    aria-busy="true"
                    aria-label={t("aiChat.chat.waiting")}
                    className="grid gap-2.5"
                  >
                    <p className="text-sm font-semibold">
                      {t("aiChat.answer.label")}
                    </p>
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-4/5" />
                    <span className="sr-only">{t("aiChat.chat.waiting")}</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div
            className={cn(
              "sticky bottom-0 mx-auto grid w-full max-w-[42rem] gap-3 pt-3 pb-1",
              management ? "bg-surface-2" : "bg-background",
            )}
          >
            {!asking && bannerKind && (
              <AskBanner
                kind={bannerKind}
                area={area}
                urgent={failure !== null}
                retrying={usage.isFetching && failure === null}
                onRetry={
                  failure
                    ? () => submit(failure.question, failure.conversationId)
                    : () => void usage.refetch()
                }
              />
            )}
            <Composer
              inputRef={composerRef}
              value={input}
              onChange={setInput}
              onSubmit={() => submit(input, activeId)}
              onStop={stop}
              busy={busy}
              disabled={paused}
              quota={quota && quota.isEnabled ? quota : null}
            />
          </div>
        </div>
      </div>

      <DeleteHistoryDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => select("new")}
      />
    </section>
  );
}
