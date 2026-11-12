// One AI answer: "Dibantu AI" label, the text, and a source card per
// `aiMessageSourceSchema` (label link, metric period) with the "Periksa
// sumber" note (PRD §3 Fitur 38 "Jawaban Bersumber"). The answer text is not
// live (it would announce every chunk while it types in); one sr-only
// `role="status"` line says the answer is ready when the reveal ends.
import { Link } from "@tanstack/react-router";
import { Clock, ExternalLink } from "lucide-react";
import type { AiMessageSource } from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { useTenantContext } from "@/lib/tenant-context";
import {
  chatPath,
  parseAnswerBlocks,
  sourceKindKey,
  sourcePeriodText,
  type ChatArea,
} from "../logic";

export function SourceCard({ source }: { source: AiMessageSource }) {
  const t = useT();
  const { brandName } = useTenantContext();
  const period = sourcePeriodText(source);
  return (
    <div className="grid gap-0.5 border-s-[3px] border-primary bg-surface-2 px-3.5 py-2.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("aiChat.answer.sourceHeading", {
          kind: t(`aiChat.answer.sourceKind.${sourceKindKey(source)}`),
        })}
      </p>
      <Link
        to={source.link as "/"}
        className="inline-flex min-h-6 w-fit max-w-full items-center gap-1 font-semibold text-primary underline underline-offset-4 hover:decoration-2"
      >
        <span className="min-w-0 break-words">{source.label}</span>
        <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">({t("aiChat.answer.sourceOpen")})</span>
      </Link>
      <p className="text-sm text-muted-foreground">
        {period
          ? t("aiChat.answer.sourceScope", { brand: brandName, period })
          : t("aiChat.answer.sourceScopeNoPeriod", { brand: brandName })}
      </p>
    </div>
  );
}

export function AnswerWithSource({
  area,
  content,
  sources,
  busy = false,
  ready = false,
  showSources = true,
  actionRequestIds = [],
}: {
  area: ChatArea;
  /** The part of the answer to show now (the whole text once it is done). */
  content: string;
  sources: readonly AiMessageSource[];
  /** The text is still typing in. */
  busy?: boolean;
  /** A typed-in answer just finished: say so once for screen readers. */
  ready?: boolean;
  showSources?: boolean;
  /** Drafts this answer created: they wait for approval, nothing changed yet. */
  actionRequestIds?: readonly string[];
}) {
  const t = useT();
  const blocks = parseAnswerBlocks(content);
  return (
    <article className="grid gap-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {t("aiChat.answer.label")}
        <Badge tone="neutral" className="border-(length:--border-w)">
          {t("aiChat.answer.badge")}
        </Badge>
      </p>
      <div aria-busy={busy} className="grid gap-2.5 text-base leading-6">
        {blocks.map((runs, index) => (
          <p key={index} className="break-words whitespace-pre-line">
            {runs.map((run, i) =>
              run.bold ? <strong key={i}>{run.text}</strong> : run.text,
            )}
          </p>
        ))}
      </div>
      <p role="status" className="sr-only">
        {ready ? t("aiChat.answer.ready") : ""}
      </p>
      {showSources && actionRequestIds.length > 0 && (
        <div className="grid gap-1.5 rounded-container border-(length:--border-w) bg-warning-subtle px-3.5 py-3">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            {t("aiChat.answer.draftTitle")}
          </p>
          <p className="text-sm">{t("aiChat.answer.draftBody")}</p>
          {area === "kelola" && (
            <Link
              to={
                `${chatPath("kelola")}/aksi/${encodeURIComponent(actionRequestIds[0]!)}` as "/"
              }
              className="w-fit font-semibold text-primary underline underline-offset-4"
            >
              {t("aiChat.answer.draftOpen")}
            </Link>
          )}
        </div>
      )}
      {showSources &&
        sources.map((source) => (
          <SourceCard key={`${source.link}|${source.label}`} source={source} />
        ))}
      {showSources && (
        <p className="text-sm text-muted-foreground">
          {t("aiChat.answer.note")}
        </p>
      )}
    </article>
  );
}
